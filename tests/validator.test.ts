import { describe, it, expect } from 'vitest';
import {
  validateResource,
  validateEvent,
  isValidTransition,
  scanForSecrets,
} from '../src/validator/index.js';
import type { Resource, CapEvent } from '../src/models/types.js';

const goodResource: Resource = {
  cap_id: 'tool_read',
  schema_version: 1,
  layer: 'cc-native',
  source: 'Read',
  what: 'Read files from local filesystem',
  account: 'N/A',
  state: {
    current: 'active',
    since: '2026-04-30T00:00:00Z',
    health: 'green',
    last_verified: '2026-04-30T00:00:00Z',
    verifier: 'cap-cli',
  },
  lifecycle: {
    proposed_by: 'tester',
    proposed_at: '2026-04-30T00:00:00Z',
    registered_at: '2026-04-30T00:00:00Z',
    verified_at: '2026-04-30T00:00:00Z',
    activated_at: '2026-04-30T00:00:00Z',
    deprecated_at: null,
    archived_at: null,
  },
  version: '1.0.0',
};

describe('validateResource', () => {
  it('accepts a well-formed resource', () => {
    const v = validateResource(goodResource);
    expect(v.ok).toBe(true);
    expect(v.issues).toEqual([]);
  });

  it('rejects an invalid cap_id', () => {
    const r = { ...goodResource, cap_id: 'Invalid Cap ID!' };
    const v = validateResource(r);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.code.startsWith('schema.'))).toBe(true);
  });

  it('rejects an invalid semver', () => {
    const r = { ...goodResource, version: 'not-a-version' };
    const v = validateResource(r);
    expect(v.ok).toBe(false);
  });

  it('rejects self-reference in composes_with', () => {
    const r = { ...goodResource, related: { composes_with: ['tool_read'] } };
    const v = validateResource(r);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.code === 'related.self_reference')).toBe(true);
  });

  it('flags an OpenAI-style key in any field', () => {
    const r = { ...goodResource, source: 'sk-abcdefghijklmnopqrstuvwxyz1234567890' };
    const v = validateResource(r);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.code === 'secret.openai_key')).toBe(true);
  });

  it('flags an Anthropic-style key', () => {
    const r = { ...goodResource, source: 'sk-ant-abcdefghijklmnopqrstuvwxyz12345' };
    const v = validateResource(r);
    expect(v.ok).toBe(false);
  });

  it('flags PII when strict mode is enabled', () => {
    const r = { ...goodResource, account: 'someone@example.com' };
    const v = validateResource(r, { strictPII: true });
    expect(v.issues.some((i) => i.code === 'pii.email_address')).toBe(true);
  });

  it('does not flag PII when strict mode is off', () => {
    const r = { ...goodResource, account: 'someone@example.com' };
    const v = validateResource(r);
    expect(v.issues.some((i) => i.code === 'pii.email_address')).toBe(false);
  });
});

describe('validateEvent', () => {
  const goodEvent: CapEvent = {
    event_id: '2026-04-30T00-00-00-000Z_tool_read_commit',
    schema_version: 1,
    cap_id: 'tool_read',
    operator: 'tester',
    phase: 'commit',
    result: 'pass',
    delta: { before: null, after: { foo: 'bar' } },
    auditable: true,
    timestamp: '2026-04-30T00:00:00Z',
  };

  it('accepts a well-formed commit event', () => {
    expect(validateEvent(goodEvent).ok).toBe(true);
  });

  it('requires parent_event on rollback', () => {
    const ev = { ...goodEvent, phase: 'rollback' as const };
    const v = validateEvent(ev);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.code === 'rollback.parent_required')).toBe(true);
  });

  it('accepts a rollback with parent_event', () => {
    const ev = { ...goodEvent, phase: 'rollback' as const, parent_event: 'orig-event-id' };
    expect(validateEvent(ev).ok).toBe(true);
  });
});

describe('isValidTransition', () => {
  it('allows proposed -> registered', () => {
    expect(isValidTransition('proposed', 'registered')).toBe(true);
  });
  it('disallows proposed -> active (must go through registered + verified)', () => {
    expect(isValidTransition('proposed', 'active')).toBe(false);
  });
  it('allows active -> deprecated', () => {
    expect(isValidTransition('active', 'deprecated')).toBe(true);
  });
  it('treats archived as terminal', () => {
    expect(isValidTransition('archived', 'active')).toBe(false);
  });
});

describe('scanForSecrets', () => {
  it('finds a secret nested deep', () => {
    const obj = { a: { b: { c: 'sk-abcdefghijklmnopqrstuvwxyz1234567890' } } };
    const issues = scanForSecrets(obj);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.path).toBe('a.b.c');
  });
  it('finds a secret in an array', () => {
    const obj = { tags: ['ok', 'AKIAIOSFODNN7EXAMPLE'] };
    const issues = scanForSecrets(obj);
    expect(issues.some((i) => i.code === 'secret.aws_access_key')).toBe(true);
  });
});

describe('schema interface tightening (HIGH finding fix)', () => {
  it('rejects an interface.outputs that is a 100KB string', () => {
    const r = {
      ...goodResource,
      interface: { outputs: 'x'.repeat(100_000) },
    };
    const v = validateResource(r);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.code.startsWith('schema.'))).toBe(true);
  });

  it('rejects an interface.inputs with too many keys', () => {
    const inputs: Record<string, string> = {};
    for (let i = 0; i < 200; i++) inputs[`key_${i}`] = 'string';
    const r = { ...goodResource, interface: { inputs } };
    const v = validateResource(r);
    expect(v.ok).toBe(false);
  });

  it('accepts a well-formed interface', () => {
    const r = {
      ...goodResource,
      interface: {
        inputs: {
          file_path: { type: 'string', required: true, description: 'absolute path' },
          limit: 'number',
        },
        outputs: 'file_contents | error',
        side_effects: 'read-only' as const,
      },
    };
    const v = validateResource(r);
    expect(v.ok).toBe(true);
  });

  it('rejects unknown side_effects', () => {
    const r = {
      ...goodResource,
      interface: { side_effects: 'world-writable' },
    };
    const v = validateResource(r);
    expect(v.ok).toBe(false);
  });
});
