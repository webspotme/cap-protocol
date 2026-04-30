/**
 * cap-protocol — SEPL operator: propose / assess / commit / rollback.
 * See SPEC.md §3.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml';
import { randomUUID } from 'node:crypto';
import type {
  Resource,
  CapEvent,
  EventResult,
  LifecycleStateName,
} from '../models/types.js';
import { EVENT_SCHEMA_VERSION } from '../models/types.js';
import {
  validateResource,
  validateEvent,
  isValidTransition,
  type ValidationIssue,
} from '../validator/index.js';
import {
  type Registry,
  readResource,
  writeResource,
  appendEvent,
  listEvents,
} from '../utils/registry.js';

export interface Proposal {
  run_id: string;
  created_at: string;
  cap_id: string;
  before: Resource | null;
  after: Resource;
}

export interface AssessmentReport {
  run_id: string;
  cap_id: string;
  result: EventResult;
  issues: ValidationIssue[];
}

function proposalsDir(reg: Registry): string {
  return join(reg.root, 'proposals');
}

function proposalPath(reg: Registry, runId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(runId)) {
    throw new Error(`invalid run_id: ${runId}`);
  }
  return join(proposalsDir(reg), `${runId}.yaml`);
}

export function propose(
  reg: Registry,
  next: Resource,
  opts: { operator?: string } = {},
): Proposal {
  const before = readResource(reg, next.cap_id);
  const proposal: Proposal = {
    run_id: `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}`,
    created_at: new Date().toISOString(),
    cap_id: next.cap_id,
    before,
    after: next,
  };
  mkdirSync(proposalsDir(reg), { recursive: true });
  writeFileSync(proposalPath(reg, proposal.run_id), stringifyYAML(proposal), 'utf8');

  // Record propose event (no state change to live resource yet)
  const ev: CapEvent = {
    event_id: `${proposal.created_at.replace(/[:.]/g, '-')}_${next.cap_id}_propose`,
    schema_version: EVENT_SCHEMA_VERSION,
    cap_id: next.cap_id,
    operator: opts.operator ?? 'cli',
    phase: 'propose',
    result: 'pass',
    delta: { before: before as unknown as Record<string, unknown> | null, after: next as unknown as Record<string, unknown> },
    auditable: true,
    timestamp: proposal.created_at,
  };
  appendEvent(reg, ev);
  return proposal;
}

export function loadProposal(reg: Registry, runId: string): Proposal {
  const p = proposalPath(reg, runId);
  if (!existsSync(p)) throw new Error(`proposal not found: ${runId}`);
  return parseYAML(readFileSync(p, 'utf8')) as Proposal;
}

export function listProposals(reg: Registry): string[] {
  const dir = proposalsDir(reg);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.slice(0, -'.yaml'.length));
}

export function assess(
  reg: Registry,
  runId: string,
  opts: { operator?: string; strictPII?: boolean } = {},
): AssessmentReport {
  const proposal = loadProposal(reg, runId);
  const validation = validateResource(proposal.after, { strictPII: opts.strictPII });
  const issues = [...validation.issues];

  // Check transition validity if there is a `before`
  if (proposal.before) {
    const fromState = proposal.before.state.current;
    const toState = proposal.after.state.current;
    if (fromState !== toState && !isValidTransition(fromState, toState)) {
      issues.push({
        severity: 'error',
        code: 'transition.disallowed',
        path: '/state/current',
        message: `transition ${fromState} -> ${toState} is not allowed by the lifecycle FSM`,
      });
    }
  }

  const result: EventResult = issues.some((i) => i.severity === 'error')
    ? 'fail'
    : issues.length > 0
      ? 'warn'
      : 'pass';

  const ev: CapEvent = {
    event_id: `${new Date().toISOString().replace(/[:.]/g, '-')}_${proposal.cap_id}_assess`,
    schema_version: EVENT_SCHEMA_VERSION,
    cap_id: proposal.cap_id,
    operator: opts.operator ?? 'cli',
    phase: 'assess',
    result,
    delta: { before: null, after: { run_id: runId, issue_count: issues.length } },
    trace: { validator_run_id: runId, notes: issues.map((i) => `[${i.severity}] ${i.code}@${i.path}: ${i.message}`).join('\n') },
    auditable: true,
  };
  appendEvent(reg, ev);

  return { run_id: runId, cap_id: proposal.cap_id, result, issues };
}

export function commit(
  reg: Registry,
  runId: string,
  opts: { operator?: string; force?: boolean } = {},
): CapEvent {
  const proposal = loadProposal(reg, runId);

  // Re-assess at commit time (G1 — atomicity / consistency).
  const assessment = assess(reg, runId, { operator: opts.operator });
  if (assessment.result === 'fail' && !opts.force) {
    throw new Error(
      `commit refused: assessment failed (${assessment.issues.filter((i) => i.severity === 'error').length} errors). Pass force:true to override.`,
    );
  }

  const ev: CapEvent = {
    event_id: `${new Date().toISOString().replace(/[:.]/g, '-')}_${proposal.cap_id}_commit`,
    schema_version: EVENT_SCHEMA_VERSION,
    cap_id: proposal.cap_id,
    operator: opts.operator ?? 'cli',
    phase: 'commit',
    result: 'pass',
    delta: {
      before: proposal.before as unknown as Record<string, unknown> | null,
      after: proposal.after as unknown as Record<string, unknown>,
    },
    auditable: true,
  };
  const validation = validateEvent(ev);
  if (!validation.ok) {
    throw new Error(`internally generated commit event failed validation: ${JSON.stringify(validation.issues)}`);
  }

  // Atomic resource write + event append
  writeResource(reg, proposal.after);
  appendEvent(reg, ev);
  return ev;
}

export function rollback(
  reg: Registry,
  eventId: string,
  opts: { operator?: string } = {},
): CapEvent {
  // Find the event being rolled back
  const allEvents = listEvents(reg);
  const target = allEvents.find((e) => e.event_id === eventId);
  if (!target) throw new Error(`event not found: ${eventId}`);
  if (target.phase !== 'commit') {
    throw new Error(`only commit events can be rolled back (this is a ${target.phase} event)`);
  }

  // Restore the prior resource state
  const before = target.delta.before as Resource | null;
  const after = target.delta.after as Resource;

  if (before === null) {
    // The original commit created the resource — rolling back means archiving.
    // We don't physically delete the file (lineage preservation); we transition
    // to `archived` state via the FSM.
    const archived: Resource = {
      ...after,
      state: {
        ...after.state,
        current: 'archived',
        since: new Date().toISOString(),
        health: 'red',
      },
      lifecycle: { ...after.lifecycle, archived_at: new Date().toISOString() },
    };
    writeResource(reg, archived);
  } else {
    writeResource(reg, before);
  }

  const ev: CapEvent = {
    event_id: `${new Date().toISOString().replace(/[:.]/g, '-')}_${target.cap_id}_rollback`,
    schema_version: EVENT_SCHEMA_VERSION,
    cap_id: target.cap_id,
    operator: opts.operator ?? 'cli',
    phase: 'rollback',
    result: 'pass',
    delta: { before: target.delta.after, after: target.delta.before },
    auditable: true,
    parent_event: target.event_id,
  };
  appendEvent(reg, ev);
  return ev;
}

/**
 * Reconstruct a resource's state at a given point in time by replaying events.
 * Implements `cap history <id> --at <ISO>` (SPEC §4.2).
 */
export function reconstructAt(reg: Registry, capId: string, atISO: string): Resource | null {
  const events = listEvents(reg, capId).filter(
    (e) => (e.timestamp ?? '') <= atISO && (e.phase === 'commit' || e.phase === 'rollback'),
  );
  let current: Resource | null = null;
  for (const ev of events) {
    if (ev.phase === 'commit') {
      current = ev.delta.after as Resource;
    } else if (ev.phase === 'rollback') {
      current = ev.delta.after as Resource | null;
    }
  }
  return current;
}

export type { LifecycleStateName };
