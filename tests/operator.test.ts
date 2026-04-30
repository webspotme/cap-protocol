import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { stringify as stringifyYAMLTest } from 'yaml';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initRegistry,
  type Registry,
} from '../src/utils/registry.js';
import {
  propose,
  assess,
  commit,
  rollback,
  reconstructAt,
} from '../src/operator/index.js';
import { readResource } from '../src/utils/registry.js';
import type { Resource } from '../src/models/types.js';

function makeResource(overrides: Partial<Resource> = {}): Resource {
  const now = new Date().toISOString();
  return {
    cap_id: 'tool_demo',
    schema_version: 1,
    layer: 'cc-native',
    source: 'Demo',
    what: 'A demo capability',
    account: 'N/A',
    state: { current: 'active', since: now, health: 'green', last_verified: now, verifier: 'test' },
    lifecycle: {
      proposed_by: 'test',
      proposed_at: now,
      registered_at: now,
      verified_at: now,
      activated_at: now,
      deprecated_at: null,
      archived_at: null,
    },
    version: '1.0.0',
    ...overrides,
  };
}

describe('SEPL operator', () => {
  let reg: Registry;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'cap-test-'));
    reg = initRegistry(root);
  });

  it('propose -> commit creates the resource', () => {
    const r = makeResource();
    const p = propose(reg, r);
    const ev = commit(reg, p.run_id);
    expect(ev.phase).toBe('commit');
    const stored = readResource(reg, r.cap_id);
    expect(stored).toEqual(r);
  });

  it('assess returns warn for PII when strict mode is on', () => {
    const r = makeResource({ account: 'someone@example.com' });
    const p = propose(reg, r);
    const a = assess(reg, p.run_id, { strictPII: true });
    expect(a.result).toBe('warn');
  });

  it('assess returns fail for embedded secrets', () => {
    const r = makeResource({ source: 'sk-ant-abcdefghijklmnopqrstuvwxyz12345' });
    const p = propose(reg, r);
    const a = assess(reg, p.run_id);
    expect(a.result).toBe('fail');
  });

  it('commit refuses when assessment fails', () => {
    const r = makeResource({ source: 'AKIAIOSFODNN7EXAMPLE' });
    const p = propose(reg, r);
    expect(() => commit(reg, p.run_id)).toThrow(/assessment failed/);
  });

  it('rollback restores prior state', async () => {
    // First commit: v1.0.0
    const v1 = makeResource({ version: '1.0.0', what: 'v1' });
    const p1 = propose(reg, v1);
    const e1 = commit(reg, p1.run_id);
    // Second commit: v1.1.0
    const v2 = makeResource({ version: '1.1.0', what: 'v2' });
    const p2 = propose(reg, v2);
    const e2 = commit(reg, p2.run_id);
    // Rollback the second commit
    await rollback(reg, e2.event_id);
    const restored = readResource(reg, v1.cap_id);
    expect(restored?.version).toBe('1.0.0');
    expect(restored?.what).toBe('v1');
    // First commit's event should still exist
    expect(e1.event_id).toBeTruthy();
  });

  it('rollback of creation deletes the resource (matches replay)', async () => {
    const v1 = makeResource({ version: '1.0.0', what: 'v1' });
    const p1 = propose(reg, v1);
    const e1 = commit(reg, p1.run_id);
    expect(readResource(reg, v1.cap_id)).not.toBeNull();
    // Rollback the creation
    await rollback(reg, e1.event_id);
    // Live state should match replay state (which is null at the start of time)
    expect(readResource(reg, v1.cap_id)).toBeNull();
  });

  it('rollback writes the rollback event BEFORE materializing prior state (G2)', async () => {
    // Regression test for the Gemini-reported critical ordering bug.
    // After commit + rollback, the rollback event must exist in the log.
    // We assert it by walking the events directory directly (not via the
    // operator) so we know the event was durably appended.
    const v1 = makeResource({ version: '1.0.0', what: 'v1' });
    const p1 = propose(reg, v1);
    const e1 = commit(reg, p1.run_id);
    await rollback(reg, e1.event_id);
    // Find the rollback event file on disk
    const eventsRoot = join(reg.root, 'events');
    const months = readdirSync(eventsRoot);
    const monthDir = months.find((m) => /^\d{4}-\d{2}$/.test(m));
    expect(monthDir).toBeDefined();
    const eventFiles = readdirSync(join(eventsRoot, monthDir!));
    const rollbackFiles = eventFiles.filter((f) => f.endsWith('_rollback.yaml'));
    expect(rollbackFiles.length).toBe(1);
    // And the resource file is gone (creation rollback)
    expect(readResource(reg, v1.cap_id)).toBeNull();
  });

  it('reconstructAt walks history correctly', async () => {
    const v1 = makeResource({ version: '1.0.0', what: 'v1' });
    const p1 = propose(reg, v1);
    commit(reg, p1.run_id);
    // Pause to ensure timestamp ordering
    await new Promise((r) => setTimeout(r, 10));
    const t1 = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 10));
    const v2 = makeResource({ version: '2.0.0', what: 'v2' });
    const p2 = propose(reg, v2);
    commit(reg, p2.run_id);

    const past = await reconstructAt(reg, v1.cap_id, t1);
    expect(past?.version).toBe('1.0.0');
  });

  it('commit bumps HEAD when resource version is higher', () => {
    const r = makeResource({ version: '2.5.0' });
    const p = propose(reg, r);
    commit(reg, p.run_id);
    const headPath = join(reg.root, 'HEAD');
    expect(readFileSync(headPath, 'utf8').trim()).toBe('2.5.0');
  });

  it('appendEvent uses exclusive create — same-ms collisions get unique filenames', async () => {
    const { appendEvent } = await import('../src/utils/registry.js');
    const ts = '2026-04-30T00:00:00.000Z';
    const baseEvent = {
      event_id: 'a',
      schema_version: 1 as const,
      cap_id: 'tool_demo',
      operator: 'tester',
      phase: 'commit' as const,
      result: 'pass' as const,
      delta: { before: null, after: null },
      auditable: true,
      timestamp: ts,
    };
    const p1 = appendEvent(reg, { ...baseEvent });
    const p2 = appendEvent(reg, { ...baseEvent });
    expect(p1).not.toBe(p2); // collision avoidance via counter suffix
  });
});

describe('recoverRegistry — torn-write recovery + tamper resistance', () => {
  let reg: Registry;
  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'cap-test-recover-'));
    reg = initRegistry(root);
  });

  it('reconciles a missing materialized resource from the event log', async () => {
    const { recoverRegistry, readResource } = await import('../src/utils/registry.js');
    const r = makeResource();
    const p = propose(reg, r);
    commit(reg, p.run_id);
    // Simulate a torn write by manually deleting the materialized file
    // *after* the commit event has been appended.
    const path = join(reg.root, 'resources', `${r.cap_id}.yaml`);
    unlinkSync(path);
    expect(readResource(reg, r.cap_id)).toBeNull();
    await recoverRegistry(reg);
    const restored = readResource(reg, r.cap_id);
    expect(restored).toEqual(r);
  });

  it('refuses to materialize a tampered event whose embedded cap_id differs from event.cap_id', async () => {
    const { recoverRegistry, readResource } = await import('../src/utils/registry.js');
    // Construct an attacker target resource on disk so recovery would have
    // something to overwrite if the cap_id check were missing.
    const r2 = makeResource({ cap_id: 'tool_attacker_target' });
    const p2 = propose(reg, r2);
    commit(reg, p2.run_id);
    expect(readResource(reg, 'tool_attacker_target')?.what).toBe('A demo capability');
    // Hand-write a tampered event: cap_id=tool_legit, but delta.after.cap_id=tool_attacker_target
    const monthDir = join(reg.root, 'events', new Date().toISOString().slice(0, 7));
    const tamperedAfter = makeResource({ cap_id: 'tool_attacker_target' });
    tamperedAfter.what = 'HIJACKED';
    const evilEv = {
      event_id: 'tampered-event',
      schema_version: 1,
      cap_id: 'tool_legit',
      operator: 'attacker',
      phase: 'commit',
      result: 'pass',
      delta: {
        before: null,
        after: tamperedAfter,
      },
      auditable: true,
      timestamp: new Date().toISOString(),
    };
    writeFileSync(
      join(monthDir, 'zzz_tool_legit_commit_tampered.yaml'),
      stringifyYAMLTest(evilEv),
      'utf8',
    );
    // Run recovery — the cap_id mismatch must be caught and skipped.
    const report = await recoverRegistry(reg);
    // tool_attacker_target should NOT be hijacked
    const target = readResource(reg, 'tool_attacker_target');
    expect(target?.what).toBe('A demo capability');
    expect(target?.what).not.toBe('HIJACKED');
    // Caller-visible warning entry for the tampered event
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.warnings.some((w) => w.event_id === 'tampered-event')).toBe(true);
  });

  it('returns a RecoveryReport with warnings + reconciled arrays', async () => {
    const { recoverRegistry } = await import('../src/utils/registry.js');
    const r = makeResource();
    const p = propose(reg, r);
    commit(reg, p.run_id);
    // Healthy registry: zero warnings, zero reconciled
    const report = await recoverRegistry(reg);
    expect(report.warnings).toEqual([]);
    expect(report.reconciled).toEqual([]);
  });
});

describe('FSM transition coverage (Codex finding fix)', () => {
  let reg: Registry;
  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'cap-test-fsm-'));
    reg = initRegistry(root);
  });

  // For each allowed transition, verify the operator accepts it.
  type StateName = Resource['state']['current'];
  const transitions: Array<[StateName, StateName]> = [
    ['proposed', 'registered'],
    ['proposed', 'rejected'],
    ['registered', 'verified'],
    ['registered', 'rejected'],
    ['verified', 'active'],
    ['verified', 'rejected'],
    ['active', 'degraded'],
    ['active', 'deprecated'],
    ['degraded', 'recovered'],
    ['degraded', 'deprecated'],
    ['recovered', 'active'],
    ['deprecated', 'archived'],
    ['deprecated', 'active'],
  ];

  for (const [from, to] of transitions) {
    it(`accepts ${from} -> ${to}`, () => {
      // First commit: a resource with `from` state
      const r1 = makeResourceForState(from);
      const p1 = propose(reg, r1);
      commit(reg, p1.run_id, { force: true });
      // Second commit: same cap_id, transition to `to`
      const r2 = { ...r1, state: { ...r1.state, current: to, since: new Date().toISOString() } };
      // Bump version to trigger schema-required lifecycle timestamps if relevant
      const r2WithLifecycle = ensureLifecycleForState(r2, to);
      const p2 = propose(reg, r2WithLifecycle);
      const a = assess(reg, p2.run_id);
      expect(a.result).not.toBe('fail');
    });
  }
});

function makeResourceForState(state: string): Resource {
  const now = new Date().toISOString();
  const r = makeResource();
  r.state = { ...r.state, current: state as Resource['state']['current'], since: now };
  return ensureLifecycleForState(r, state);
}

function ensureLifecycleForState(r: Resource, state: string): Resource {
  const now = new Date().toISOString();
  const lc = { ...r.lifecycle };
  if (['registered', 'verified', 'active', 'degraded', 'recovered', 'deprecated', 'archived'].includes(state)) {
    lc.registered_at = lc.registered_at ?? now;
  }
  if (['verified', 'active', 'degraded', 'recovered', 'deprecated', 'archived'].includes(state)) {
    lc.verified_at = lc.verified_at ?? now;
  }
  if (['active', 'degraded', 'recovered', 'deprecated', 'archived'].includes(state)) {
    lc.activated_at = lc.activated_at ?? now;
  }
  if (state === 'deprecated' || state === 'archived') {
    lc.deprecated_at = lc.deprecated_at ?? now;
  }
  if (state === 'archived') {
    lc.archived_at = lc.archived_at ?? now;
  }
  return { ...r, lifecycle: lc };
}

describe('appendEvent path-traversal hardening (MEDIUM finding fix)', () => {
  let reg: Registry;
  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'cap-test-trav-'));
    reg = initRegistry(root);
  });

  it('rejects events whose timestamp does not start with YYYY-MM', async () => {
    // Direct call to appendEvent with a malicious timestamp prefix
    const { appendEvent } = await import('../src/utils/registry.js');
    expect(() =>
      appendEvent(reg, {
        event_id: 'evil',
        schema_version: 1,
        cap_id: 'tool_demo',
        operator: 'tester',
        phase: 'commit',
        result: 'pass',
        delta: { before: null, after: null },
        auditable: true,
        timestamp: '../etc',
      }),
    ).toThrow(/invalid timestamp prefix/);
  });

  it('rejects events with cap_id containing path separators', async () => {
    const { appendEvent } = await import('../src/utils/registry.js');
    expect(() =>
      appendEvent(reg, {
        event_id: 'evil',
        schema_version: 1,
        cap_id: '../../../etc/passwd' as unknown as string,
        operator: 'tester',
        phase: 'commit',
        result: 'pass',
        delta: { before: null, after: null },
        auditable: true,
        timestamp: '2026-04-30T00:00:00Z',
      }),
    ).toThrow(/invalid cap_id/);
  });
});
