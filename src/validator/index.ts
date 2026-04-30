/**
 * cap-protocol — schema + semantic validator.
 * Implements SPEC §4.1 (schema) and §5.2 (secret hygiene pre-check).
 */

// Use the draft-2020-12 entry point so the metaschema referenced by our
// schema files (`"$schema": "https://json-schema.org/draft/2020-12/schema"`)
// is loaded. The default `ajv` import only ships draft-07.
import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import semver from 'semver';
import type { Resource, CapEvent } from '../models/types.js';
import { ALLOWED_TRANSITIONS } from '../models/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Schemas live at <package-root>/schema/
const SCHEMA_DIR = resolve(__dirname, '..', '..', 'schema');

let _resourceValidate: ValidateFunction | null = null;
let _eventValidate: ValidateFunction | null = null;

function getValidators() {
  if (_resourceValidate && _eventValidate) {
    return { resource: _resourceValidate, event: _eventValidate };
  }
  // strictTypes / strictRequired are turned off because our `allOf/if/then`
  // conditionals describe nested `properties.lifecycle` blocks that add
  // `required` entries without redeclaring the parent `properties.lifecycle`
  // schema in full. Ajv flags this as a style issue but the schemas are
  // valid JSON Schema 2020-12. allErrors and other strict checks remain on.
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictTypes: false,
    strictRequired: false,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  const resourceSchema = JSON.parse(readFileSync(resolve(SCHEMA_DIR, 'resource.schema.json'), 'utf8'));
  const eventSchema = JSON.parse(readFileSync(resolve(SCHEMA_DIR, 'event.schema.json'), 'utf8'));
  _resourceValidate = ajv.compile(resourceSchema);
  _eventValidate = ajv.compile(eventSchema);
  return { resource: _resourceValidate, event: _eventValidate };
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/**
 * Patterns that strongly suggest a value contains secret material.
 * These are conservative — they flag for review rather than auto-redact.
 *
 * IMPORTANT: This is a hygiene aid, not a security boundary.
 * Operators MUST treat their registry files as source-of-truth-grade artifacts
 * and apply their own secret scanning at commit time.
 */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'openai_key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'stripe_key', re: /\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]{20,}\b/ },
  { name: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'private_key_block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'high_entropy_b64', re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/ },
];

const PII_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'email_address', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { name: 'phone_e164', re: /\+[1-9]\d{6,14}\b/ },
  { name: 'ipv4', re: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/ },
];

/**
 * Pre-commit hygiene scan. Returns issues for any field value that matches
 * a secret pattern OR (when strict) a PII pattern.
 *
 * Note: high_entropy_b64 is included but routed to severity:warning to avoid
 * flagging legitimate identifiers (UUIDs are typically <40 chars).
 */
export function scanForSecrets(
  obj: unknown,
  opts: { strictPII?: boolean; pathPrefix?: string } = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const visit = (val: unknown, path: string): void => {
    if (val === null || val === undefined) return;
    if (typeof val === 'string') {
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(val)) {
          issues.push({
            severity: name === 'high_entropy_b64' ? 'warning' : 'error',
            code: `secret.${name}`,
            path,
            message: `String at ${path} matches pattern for ${name}; secret material MUST NOT be stored in registry files.`,
          });
        }
      }
      if (opts.strictPII) {
        for (const { name, re } of PII_PATTERNS) {
          if (re.test(val)) {
            issues.push({
              severity: 'warning',
              code: `pii.${name}`,
              path,
              message: `String at ${path} contains ${name}; consider abstracting (e.g., "service-account" instead of a personal email).`,
            });
          }
        }
      }
      return;
    }
    if (Array.isArray(val)) {
      val.forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    if (typeof val === 'object') {
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        visit(v, path === '' ? k : `${path}.${k}`);
      }
    }
  };
  visit(obj, opts.pathPrefix ?? '');
  return issues;
}

export function validateResource(
  candidate: unknown,
  opts: { strictPII?: boolean } = {},
): ValidationResult {
  const { resource } = getValidators();
  const issues: ValidationIssue[] = [];

  const ok = resource(candidate);
  if (!ok && resource.errors) {
    for (const err of resource.errors) {
      issues.push({
        severity: 'error',
        code: `schema.${err.keyword}`,
        path: err.instancePath || '/',
        message: err.message ?? 'schema validation failed',
      });
    }
  }

  // Semantic checks layered on top of schema
  if (ok) {
    const r = candidate as Resource;
    if (!semver.valid(r.version)) {
      issues.push({
        severity: 'error',
        code: 'semver.invalid',
        path: '/version',
        message: `version "${r.version}" is not valid semver`,
      });
    }
    if (r.related?.composes_with?.includes(r.cap_id)) {
      issues.push({
        severity: 'error',
        code: 'related.self_reference',
        path: '/related/composes_with',
        message: 'A resource cannot compose with itself',
      });
    }
    if (r.related?.superseded_by === r.cap_id || r.related?.supersedes === r.cap_id) {
      issues.push({
        severity: 'error',
        code: 'related.self_reference',
        path: '/related',
        message: 'superseded_by/supersedes cannot reference the resource itself',
      });
    }
  }

  // Secret/PII scan
  issues.push(...scanForSecrets(candidate, opts));

  return { ok: issues.every((i) => i.severity !== 'error'), issues };
}

export function validateEvent(candidate: unknown): ValidationResult {
  const { event } = getValidators();
  const issues: ValidationIssue[] = [];
  const ok = event(candidate);
  if (!ok && event.errors) {
    for (const err of event.errors) {
      issues.push({
        severity: 'error',
        code: `schema.${err.keyword}`,
        path: err.instancePath || '/',
        message: err.message ?? 'schema validation failed',
      });
    }
  }
  if (ok) {
    const e = candidate as CapEvent;
    if (e.phase === 'rollback' && !e.parent_event) {
      issues.push({
        severity: 'error',
        code: 'rollback.parent_required',
        path: '/parent_event',
        message: 'rollback events MUST set parent_event',
      });
    }
  }
  return { ok: issues.every((i) => i.severity !== 'error'), issues };
}

export function isValidTransition(
  from: Resource['state']['current'],
  to: Resource['state']['current'],
): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
