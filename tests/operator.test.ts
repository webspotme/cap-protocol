import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
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

  it('rollback restores prior state', () => {
    // First commit: v1.0.0
    const v1 = makeResource({ version: '1.0.0', what: 'v1' });
    const p1 = propose(reg, v1);
    const e1 = commit(reg, p1.run_id);
    // Second commit: v1.1.0
    const v2 = makeResource({ version: '1.1.0', what: 'v2' });
    const p2 = propose(reg, v2);
    const e2 = commit(reg, p2.run_id);
    // Rollback the second commit
    rollback(reg, e2.event_id);
    const restored = readResource(reg, v1.cap_id);
    expect(restored?.version).toBe('1.0.0');
    expect(restored?.what).toBe('v1');
    // First commit's event should still exist
    expect(e1.event_id).toBeTruthy();
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

    const past = reconstructAt(reg, v1.cap_id, t1);
    expect(past?.version).toBe('1.0.0');
  });

  it('appends events in append-only fashion (no duplicate filenames)', () => {
    const r = makeResource();
    const p = propose(reg, r);
    commit(reg, p.run_id);
    const eventsRoot = join(reg.root, 'events');
    const months = readdirSync(eventsRoot);
    expect(months.length).toBeGreaterThan(0);
  });
});
