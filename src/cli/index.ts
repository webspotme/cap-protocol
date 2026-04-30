#!/usr/bin/env node
/**
 * cap-protocol — CLI entry point.
 * See SPEC §4.2 for the recommended command surface.
 */

import { Command } from 'commander';
import { stringify as stringifyYAML } from 'yaml';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  openRegistry,
  initRegistry,
  readResource,
  listResources,
  listEvents,
  readHead,
} from '../utils/registry.js';
import {
  propose,
  assess,
  commit,
  rollback,
  reconstructAt,
} from '../operator/index.js';
import { validateResource } from '../validator/index.js';
import type { Resource } from '../models/types.js';

const program = new Command();

program
  .name('cap')
  .description('cap-protocol — capability registry CLI')
  .version('0.1.0');

program
  .command('init <path>')
  .description('Initialize an empty cap-protocol registry')
  .action((path: string) => {
    const reg = initRegistry(path);
    process.stdout.write(`initialized registry at ${reg.root}\n`);
  });

program
  .command('propose')
  .description('Propose a new or updated resource')
  .requiredOption('-r, --root <path>', 'registry root')
  .option('--from-file <path>', 'load proposed resource from a YAML file')
  .option('--id <cap_id>')
  .option('--layer <layer>')
  .option('--source <source>')
  .option('--what <what>')
  .option('--account <account>', '"N/A" if none', 'N/A')
  .option('--operator <name>', 'who is proposing', 'cli')
  .action((opts: { root: string; fromFile?: string; id?: string; layer?: string; source?: string; what?: string; account: string; operator: string }) => {
    const reg = openRegistry(opts.root);
    let candidate: Resource;
    if (opts.fromFile) {
      const yaml = readFileSync(resolve(opts.fromFile), 'utf8');
      candidate = parseYAMLOrThrow(yaml);
    } else {
      if (!opts.id || !opts.layer || !opts.source || !opts.what) {
        throw new Error('--id, --layer, --source, --what required when --from-file is not used');
      }
      const now = new Date().toISOString();
      candidate = {
        cap_id: opts.id,
        schema_version: 1,
        layer: opts.layer,
        source: opts.source,
        what: opts.what,
        account: opts.account,
        state: { current: 'proposed', since: now, health: 'green', last_verified: null, verifier: null },
        lifecycle: { proposed_by: opts.operator, proposed_at: now, registered_at: null, verified_at: null, activated_at: null, deprecated_at: null, archived_at: null },
        version: '0.1.0',
      };
    }
    const v = validateResource(candidate);
    if (!v.ok) {
      process.stderr.write('proposal failed schema validation:\n');
      for (const i of v.issues) process.stderr.write(`  [${i.severity}] ${i.code}@${i.path}: ${i.message}\n`);
      process.exit(2);
    }
    const p = propose(reg, candidate, { operator: opts.operator });
    process.stdout.write(`${p.run_id}\n`);
  });

program
  .command('assess <run_id>')
  .description('Validate a proposal against the live registry')
  .requiredOption('-r, --root <path>', 'registry root')
  .option('--strict-pii', 'flag PII patterns as warnings (recommended for public registries)')
  .option('--operator <name>', 'who is assessing', 'cli')
  .action((runId: string, opts: { root: string; strictPii?: boolean; operator: string }) => {
    const reg = openRegistry(opts.root);
    const report = assess(reg, runId, { operator: opts.operator, strictPII: opts.strictPii });
    process.stdout.write(`result: ${report.result}\n`);
    if (report.issues.length > 0) {
      process.stdout.write(`issues:\n`);
      for (const i of report.issues) process.stdout.write(`  [${i.severity}] ${i.code}@${i.path}: ${i.message}\n`);
    }
    process.exit(report.result === 'fail' ? 1 : 0);
  });

program
  .command('commit <run_id>')
  .description('Apply a proposal to the registry (atomic)')
  .requiredOption('-r, --root <path>', 'registry root')
  .option('-f, --force', 'commit even if assessment fails')
  .option('--operator <name>', 'who is committing', 'cli')
  .action((runId: string, opts: { root: string; force?: boolean; operator: string }) => {
    const reg = openRegistry(opts.root);
    const ev = commit(reg, runId, { operator: opts.operator, force: opts.force });
    process.stdout.write(`${ev.event_id}\n`);
  });

program
  .command('rollback <event_id>')
  .description('Roll back a previously committed event')
  .requiredOption('-r, --root <path>', 'registry root')
  .option('--operator <name>', 'who is rolling back', 'cli')
  .action((eventId: string, opts: { root: string; operator: string }) => {
    const reg = openRegistry(opts.root);
    const ev = rollback(reg, eventId, { operator: opts.operator });
    process.stdout.write(`${ev.event_id}\n`);
  });

program
  .command('show <cap_id>')
  .description('Show current resource')
  .requiredOption('-r, --root <path>', 'registry root')
  .action((capId: string, opts: { root: string }) => {
    const reg = openRegistry(opts.root);
    const r = readResource(reg, capId);
    if (!r) {
      process.stderr.write(`not found: ${capId}\n`);
      process.exit(1);
    }
    process.stdout.write(stringifyYAML(r));
  });

program
  .command('history <cap_id>')
  .description('Show event timeline for a resource')
  .requiredOption('-r, --root <path>', 'registry root')
  .option('--at <ISO>', 'reconstruct state as of this timestamp')
  .action((capId: string, opts: { root: string; at?: string }) => {
    const reg = openRegistry(opts.root);
    if (opts.at) {
      const r = reconstructAt(reg, capId, opts.at);
      if (!r) {
        process.stderr.write(`no committed state at ${opts.at}\n`);
        process.exit(1);
      }
      process.stdout.write(stringifyYAML(r));
      return;
    }
    const events = listEvents(reg, capId);
    for (const e of events) {
      process.stdout.write(`${e.timestamp ?? '?'}  ${e.phase.padEnd(8)} ${e.result.padEnd(4)} ${e.event_id}\n`);
    }
  });

program
  .command('list')
  .description('List resources')
  .requiredOption('-r, --root <path>', 'registry root')
  .option('--layer <layer>')
  .option('--state <state>')
  .action((opts: { root: string; layer?: string; state?: string }) => {
    const reg = openRegistry(opts.root);
    const ids = listResources(reg);
    for (const id of ids) {
      const r = readResource(reg, id);
      if (!r) continue;
      if (opts.layer && r.layer !== opts.layer) continue;
      if (opts.state && r.state.current !== opts.state) continue;
      process.stdout.write(`${id.padEnd(48)} ${r.layer.padEnd(20)} ${r.state.current.padEnd(12)} v${r.version}\n`);
    }
  });

program
  .command('head')
  .description('Show registry HEAD version')
  .requiredOption('-r, --root <path>', 'registry root')
  .action((opts: { root: string }) => {
    process.stdout.write(`${readHead(openRegistry(opts.root))}\n`);
  });

function parseYAMLOrThrow(yaml: string): Resource {
  // Lazy import to keep CLI startup fast
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { parse } = require('yaml');
  return parse(yaml) as Resource;
}

program.parseAsync().catch((err: Error) => {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
});
