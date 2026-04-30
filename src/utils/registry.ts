/**
 * cap-protocol — registry I/O helpers.
 * Filesystem layout per SPEC §2.6.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml';
import type { Resource, CapEvent } from '../models/types.js';

export interface Registry {
  root: string;
}

export function openRegistry(root: string): Registry {
  const r = resolve(root);
  if (!existsSync(r)) {
    throw new Error(`registry root does not exist: ${r}`);
  }
  if (!existsSync(join(r, 'resources'))) {
    throw new Error(`not a cap-protocol registry (missing resources/): ${r}`);
  }
  return { root: r };
}

export function initRegistry(root: string): Registry {
  const r = resolve(root);
  mkdirSync(join(r, 'resources'), { recursive: true });
  mkdirSync(join(r, 'events'), { recursive: true });
  mkdirSync(join(r, 'manifests'), { recursive: true });
  mkdirSync(join(r, 'proposals'), { recursive: true });
  if (!existsSync(join(r, 'HEAD'))) {
    writeFileSync(join(r, 'HEAD'), '0.1.0\n', 'utf8');
  }
  if (!existsSync(join(r, 'CHANGELOG.md'))) {
    writeFileSync(join(r, 'CHANGELOG.md'), '# CHANGELOG\n\n## v0.1.0\n- Registry initialized.\n', 'utf8');
  }
  return { root: r };
}

function resourcePath(reg: Registry, capId: string): string {
  // Path is constructed from a validated cap_id pattern (^[a-z][a-z0-9_]{1,127}$);
  // path-traversal characters cannot appear in a valid cap_id.
  if (!/^[a-z][a-z0-9_]{1,127}$/.test(capId)) {
    throw new Error(`invalid cap_id: ${capId}`);
  }
  return join(reg.root, 'resources', `${capId}.yaml`);
}

export function readResource(reg: Registry, capId: string): Resource | null {
  const p = resourcePath(reg, capId);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8');
  return parseYAML(raw) as Resource;
}

/**
 * Atomic write: write to a tmp file alongside the target, then rename.
 * Rename is atomic on POSIX filesystems for same-directory renames.
 * See SPEC §3.3 G1 (Atomicity).
 */
export function writeResource(reg: Registry, resource: Resource): void {
  const target = resourcePath(reg, resource.cap_id);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, stringifyYAML(resource), 'utf8');
  renameSync(tmp, target);
}

export function listResources(reg: Registry): string[] {
  const dir = join(reg.root, 'resources');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.slice(0, -'.yaml'.length))
    .sort();
}

export function appendEvent(reg: Registry, event: CapEvent): string {
  const ts = event.timestamp ?? new Date().toISOString();
  const safeTs = ts.replace(/[:.]/g, '-');
  const monthDir = ts.slice(0, 7); // YYYY-MM
  const dir = join(reg.root, 'events', monthDir);
  mkdirSync(dir, { recursive: true });
  const fname = `${safeTs}_${event.cap_id}_${event.phase}.yaml`;
  const path = join(dir, fname);
  if (existsSync(path)) {
    throw new Error(`event file already exists (refusing to overwrite — events are append-only): ${path}`);
  }
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, stringifyYAML({ ...event, timestamp: ts }), 'utf8');
  renameSync(tmp, path);
  return path;
}

export function listEvents(reg: Registry, capId?: string): CapEvent[] {
  const eventsDir = join(reg.root, 'events');
  if (!existsSync(eventsDir)) return [];
  const out: CapEvent[] = [];
  for (const month of readdirSync(eventsDir)) {
    const monthPath = join(eventsDir, month);
    if (!statSync(monthPath).isDirectory()) continue;
    for (const f of readdirSync(monthPath)) {
      if (!f.endsWith('.yaml')) continue;
      const ev = parseYAML(readFileSync(join(monthPath, f), 'utf8')) as CapEvent;
      if (!capId || ev.cap_id === capId) out.push(ev);
    }
  }
  out.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
  return out;
}

export function readHead(reg: Registry): string {
  return readFileSync(join(reg.root, 'HEAD'), 'utf8').trim();
}

export function writeHead(reg: Registry, version: string): void {
  const target = join(reg.root, 'HEAD');
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, `${version}\n`, 'utf8');
  renameSync(tmp, target);
}
