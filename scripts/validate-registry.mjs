#!/usr/bin/env node
/**
 * Validates every YAML file in a registry's resources/ directory against the
 * cap-protocol resource schema.
 *
 * Usage: node scripts/validate-registry.mjs <registry-root>
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYAML } from 'yaml';
import { validateResource } from '../dist/index.js';

const root = process.argv[2];
if (!root) {
  process.stderr.write('usage: validate-registry.mjs <registry-root>\n');
  process.exit(2);
}

const resourcesDir = resolve(root, 'resources');
let okCount = 0;
let failCount = 0;

for (const fname of readdirSync(resourcesDir)) {
  if (!fname.endsWith('.yaml')) continue;
  const path = join(resourcesDir, fname);
  const yaml = readFileSync(path, 'utf8');
  let parsed;
  try {
    parsed = parseYAML(yaml);
  } catch (err) {
    process.stderr.write(`PARSE_ERROR ${fname}: ${err.message}\n`);
    failCount++;
    continue;
  }
  const v = validateResource(parsed, { strictPII: true });
  if (!v.ok) {
    process.stderr.write(`FAIL ${fname}:\n`);
    for (const issue of v.issues.filter((i) => i.severity === 'error')) {
      process.stderr.write(`  ${issue.code}@${issue.path}: ${issue.message}\n`);
    }
    failCount++;
  } else {
    if (v.issues.length > 0) {
      process.stderr.write(`WARN ${fname}: ${v.issues.length} warnings\n`);
    }
    okCount++;
  }
}

process.stdout.write(`Validated ${okCount + failCount} files: ${okCount} ok, ${failCount} failed\n`);
process.exit(failCount === 0 ? 0 : 1);
