#!/usr/bin/env node
/**
 * Generate the public example registry from scripts/public-capabilities.json.
 *
 * Output: examples/example-registry/resources/<cap_id>.yaml
 *
 * Every entry uses `account: service-account`. No PII, no production paths.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYAML } from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT = resolve(__dirname, '..');
const SOURCE = resolve(ROOT, 'scripts', 'public-capabilities.json');
const OUT_DIR = resolve(ROOT, 'examples', 'example-registry', 'resources');

const NOW = '2026-04-30T00:00:00Z';

const data = JSON.parse(readFileSync(SOURCE, 'utf8'));
mkdirSync(OUT_DIR, { recursive: true });

let count = 0;
for (const entry of data.capabilities) {
  const resource = {
    cap_id: entry.cap_id,
    schema_version: 1,
    layer: entry.layer,
    source: entry.source,
    what: entry.what,
    account: 'service-account',
    state: {
      current: 'active',
      since: NOW,
      health: 'green',
      last_verified: NOW,
      verifier: 'cap-protocol-example-generator',
    },
    lifecycle: {
      proposed_by: 'cap-protocol-example-generator',
      proposed_at: NOW,
      registered_at: NOW,
      verified_at: NOW,
      activated_at: NOW,
      deprecated_at: null,
      archived_at: null,
    },
    version: '1.0.0',
    provenance: {
      added_by: 'cap-protocol-example-generator',
      evidence: 'public documentation (Anthropic CC docs / MCP server READMEs / anthropic/example-skills)',
    },
  };
  writeFileSync(resolve(OUT_DIR, `${entry.cap_id}.yaml`), stringifyYAML(resource), 'utf8');
  count++;
}

process.stdout.write(`Generated ${count} resource files in ${OUT_DIR}\n`);
