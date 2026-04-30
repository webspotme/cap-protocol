/**
 * cap-protocol — SEPL operator: propose / assess / commit / rollback.
 * See SPEC.md §3.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml';
import { randomUUID } from 'node:crypto';
import semver from 'semver';
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
  listEventsValidated,
  readHead,
  writeHead,
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
  opts: { operator?: string; force?: boolean; strictPII?: boolean } = {},
): CapEvent {
  const proposal = loadProposal(reg, runId);

  // Re-assess at commit time (consistency check on the live registry).
  const assessment = assess(reg, runId, { operator: opts.operator, strictPII: opts.strictPII });
  if (assessment.result === 'fail' && !opts.force) {
    throw new Error(
      `commit refused: assessment failed (${assessment.issues.filter((i) => i.severity === 'error').length} errors). Pass force:true to override.`,
    );
  }

  const now = new Date().toISOString();
  const ev: CapEvent = {
    event_id: `${now.replace(/[:.]/g, '-')}_${proposal.cap_id}_commit`,
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
    timestamp: now,
  };
  const validation = validateEvent(ev);
  if (!validation.ok) {
    throw new Error(`internally generated commit event failed validation: ${JSON.stringify(validation.issues)}`);
  }

  // Atomicity strategy (SPEC §3.3 G1):
  //
  //   1. Append the commit event using O_CREAT|O_EXCL. If we crash before
  //      this step, no state has changed.
  //   2. Write the resource via atomic same-directory rename. If we crash
  //      between step 1 and step 2, the event log will have a commit event
  //      that points to a resource state that wasn't yet materialized — but
  //      `reconstructFromEvents` (the canonical replay path) will derive
  //      the correct state from the event log on next open. The live
  //      resource file may be reconstructed by an integrity-check pass.
  //   3. Bump HEAD if the resource version is higher than current HEAD.
  //      HEAD bump is non-essential for correctness — losing a HEAD bump
  //      between step 2 and step 3 is recoverable from the event log.
  //
  // The event log is the source of truth; resource files are a materialized
  // cache derived from it. This is the ONLY safe ordering: if we wrote the
  // resource first and crashed before appending the event, the audit trail
  // would be lost forever (G2 violation).

  appendEvent(reg, ev);          // step 1: durably record the change
  writeResource(reg, proposal.after); // step 2: materialize the new state
  bumpHeadIfHigher(reg, proposal.after.version); // step 3: registry-level version bump
  return ev;
}

function bumpHeadIfHigher(reg: Registry, candidateVersion: string): void {
  if (!semver.valid(candidateVersion)) return;
  const current = readHead(reg);
  if (!semver.valid(current) || semver.gt(candidateVersion, current)) {
    writeHead(reg, candidateVersion);
  }
}

export async function rollback(
  reg: Registry,
  eventId: string,
  opts: { operator?: string } = {},
): Promise<CapEvent> {
  // Use the validated reader — rollback is security-sensitive: we will
  // write delta.before back as a Resource, so we must trust the event.
  const allEvents = await listEventsValidated(reg);
  const target = allEvents.find((e) => e.event_id === eventId);
  if (!target) throw new Error(`event not found or failed validation: ${eventId}`);
  if (target.phase !== 'commit') {
    throw new Error(`only commit events can be rolled back (this is a ${target.phase} event)`);
  }

  const before = target.delta.before as Resource | null;

  // Pre-validate the embedded `before` payload BEFORE we write any event or
  // touch the materialized resource. A tampered event file could embed a
  // malicious payload, and although listEventsValidated checks event-level
  // schema, the embedded `before` is only loosely typed at the event schema
  // layer.
  if (before !== null) {
    const v = validateResource(before);
    if (!v.ok) {
      throw new Error(
        `rollback refused: event ${eventId}.delta.before failed Resource validation (${v.issues.filter((i) => i.severity === 'error').length} errors)`,
      );
    }
  }

  const now = new Date().toISOString();
  const ev: CapEvent = {
    event_id: `${now.replace(/[:.]/g, '-')}_${target.cap_id}_rollback`,
    schema_version: EVENT_SCHEMA_VERSION,
    cap_id: target.cap_id,
    operator: opts.operator ?? 'cli',
    phase: 'rollback',
    result: 'pass',
    delta: { before: target.delta.after, after: target.delta.before },
    auditable: true,
    parent_event: target.event_id,
    timestamp: now,
  };
  const validation = validateEvent(ev);
  if (!validation.ok) {
    throw new Error(`internally generated rollback event failed validation: ${JSON.stringify(validation.issues)}`);
  }

  // Atomicity (mirrors commit() — SPEC §3.3 G2):
  //   1. Append the rollback event with O_CREAT|O_EXCL. If we crash here,
  //      no state has changed.
  //   2. Materialize the prior resource state (write or unlink). If we
  //      crash between 1 and 2, replay (`reconstructAt`) will return the
  //      correct rolled-back state from the event log; the materialized
  //      cache can be rebuilt on next open.
  //
  // The event log is the source of truth — auditable G2 requires that
  // every materialized state change be preceded by a durable event.
  appendEvent(reg, ev);            // step 1: durable audit record
  if (before !== null) {
    writeResource(reg, before);    // step 2: materialize prior state
  } else {
    // Creation rollback: prior state was absence. Delete the file so
    // live state matches `reconstructAt` (which returns null at this
    // point in the timeline).
    const path = join(reg.root, 'resources', `${target.cap_id}.yaml`);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }

  return ev;
}

/**
 * Reconstruct a resource's state at a given point in time by replaying events.
 * Implements `cap history <id> --at <ISO>` (SPEC §4.2).
 *
 * Uses the validated event reader AND validates each embedded resource
 * snapshot (`delta.after`) before trusting it. The event schema only
 * requires `delta.after` to be an object/null; the embedded Resource shape
 * needs its own validation pass before any reader returns it as a trusted
 * Resource. (Codex round 2 P1 #2.)
 */
export async function reconstructAt(reg: Registry, capId: string, atISO: string): Promise<Resource | null> {
  const events = (await listEventsValidated(reg, capId)).filter(
    (e) => (e.timestamp ?? '') <= atISO && (e.phase === 'commit' || e.phase === 'rollback'),
  );
  let current: Resource | null = null;
  for (const ev of events) {
    const after = ev.delta.after as Resource | null;
    if (after !== null) {
      const v = validateResource(after);
      if (!v.ok) {
        process.stderr.write(
          `warning: skipping event ${ev.event_id} during reconstructAt — embedded resource fails validation\n`,
        );
        continue;
      }
    }
    if (ev.phase === 'commit' || ev.phase === 'rollback') {
      current = after;
    }
  }
  return current;
}

export type { LifecycleStateName };
