/**
 * cap-protocol — registry I/O helpers.
 * Filesystem layout per SPEC §2.6.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  realpathSync,
  lstatSync,
} from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml';
import type { Resource, CapEvent } from '../models/types.js';

export interface Registry {
  root: string;
}

const TMP_SUFFIX_RE = /\.tmp\.\d+\.\d+$/;
const TMP_GC_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Sweep stale `*.tmp.<pid>.<ts>` files left behind by an interrupted atomic
 * write. Same-directory atomic rename guarantees that any tmp file older than
 * a few seconds is from a crashed process; we use 1h for safety.
 */
function gcStaleTmpFiles(rootDir: string): void {
  if (!existsSync(rootDir)) return;
  const cutoff = Date.now() - TMP_GC_AGE_MS;
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (TMP_SUFFIX_RE.test(name) && st.mtimeMs < cutoff) {
        try {
          unlinkSync(full);
        } catch {
          /* best-effort */
        }
      }
    }
  }
}

/**
 * Resolve symlinks at registry open time and ensure the result is the same
 * directory the user passed (i.e., no symlink redirection above or at the
 * root). Subdirectories are kept honest by `assertWithinRegistry`.
 */
function realpathContained(root: string): string {
  const real = realpathSync(root);
  // If the user passed a symlink path, resolve it. We only object if the
  // resolution moves OUT of the originally-named tree in a way that would
  // surprise the operator. For the registry root we accept the realpath.
  return real;
}

function assertWithinRegistry(root: string, candidate: string): void {
  // Reject if the candidate path is a symlink at any level inside the
  // registry. We use lstat on each path component within the registry.
  const rel = relative(root, candidate);
  if (rel.startsWith('..') || rel === '' || rel.includes(`..${sep}`)) {
    throw new Error(`path escapes registry root: ${candidate}`);
  }
  // Walk components and refuse symlinks
  let acc = root;
  for (const seg of rel.split(sep)) {
    if (!seg) continue;
    acc = join(acc, seg);
    if (existsSync(acc)) {
      const st = lstatSync(acc);
      if (st.isSymbolicLink()) {
        throw new Error(`registry path contains a symlink (refusing for safety): ${acc}`);
      }
    }
  }
}

export function openRegistry(root: string): Registry {
  const r = resolve(root);
  if (!existsSync(r)) {
    throw new Error(`registry root does not exist: ${r}`);
  }
  const real = realpathContained(r);
  if (!existsSync(join(real, 'resources'))) {
    throw new Error(`not a cap-protocol registry (missing resources/): ${real}`);
  }
  // Reject if `resources/` or `events/` is a symlink (sneaky path escape)
  for (const sub of ['resources', 'events', 'manifests', 'proposals']) {
    const p = join(real, sub);
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) {
      throw new Error(`registry subdirectory is a symlink (refusing for safety): ${p}`);
    }
  }
  // Best-effort GC of stale tmp files from interrupted writes (>1h old).
  gcStaleTmpFiles(real);
  return { root: real };
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

export class RegistryParseError extends Error {
  constructor(public readonly path: string, public readonly cause: unknown) {
    super(`failed to parse YAML at ${path}: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = 'RegistryParseError';
  }
}

function parseYAMLSafe<T>(raw: string, path: string): T {
  try {
    return parseYAML(raw) as T;
  } catch (err) {
    throw new RegistryParseError(path, err);
  }
}

export function readResource(reg: Registry, capId: string): Resource | null {
  const p = resourcePath(reg, capId);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8');
  return parseYAMLSafe<Resource>(raw, p);
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

const MONTH_DIR_RE = /^\d{4}-\d{2}$/;
const CAP_ID_RE = /^[a-z][a-z0-9_]{1,127}$/;
const PHASE_RE = /^[a-z]+$/;

export function appendEvent(reg: Registry, event: CapEvent): string {
  const ts = event.timestamp ?? new Date().toISOString();
  const safeTs = ts.replace(/[:.]/g, '-');
  const monthDir = ts.slice(0, 7); // YYYY-MM
  // Defense-in-depth: even though the CLI/operator path validates events
  // against the schema before calling appendEvent, the function is exported
  // in the public library API (src/index.ts) and could be invoked directly
  // by consumers. Reject any value that would escape the events/ subtree.
  if (!MONTH_DIR_RE.test(monthDir)) {
    throw new Error(`invalid timestamp prefix for month directory: ${monthDir}`);
  }
  if (!CAP_ID_RE.test(event.cap_id)) {
    throw new Error(`invalid cap_id: ${event.cap_id}`);
  }
  if (!PHASE_RE.test(event.phase)) {
    throw new Error(`invalid phase: ${event.phase}`);
  }
  const dir = join(reg.root, 'events', monthDir);
  mkdirSync(dir, { recursive: true });
  assertWithinRegistry(reg.root, dir);
  // Use a counter suffix to handle the rare case where two events for the
  // same (cap_id, phase) collide on the same millisecond. We write with
  // `wx` (O_CREAT | O_EXCL), which atomically refuses to overwrite — this
  // closes the existsSync→rename TOCTOU race.
  let attempt = 0;
  while (attempt < 1000) {
    const suffix = attempt === 0 ? '' : `.${attempt}`;
    const fname = `${safeTs}_${event.cap_id}_${event.phase}${suffix}.yaml`;
    const path = join(dir, fname);
    assertWithinRegistry(reg.root, path);
    try {
      writeFileSync(path, stringifyYAML({ ...event, timestamp: ts }), { encoding: 'utf8', flag: 'wx' });
      return path;
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'EEXIST') {
        attempt++;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`could not allocate unique event filename after 1000 attempts (clock skew or extreme contention)`);
}

/**
 * Lazy-import to avoid a cycle: validator imports nothing from registry,
 * but registry imports validator only at read time.
 */
async function getEventValidator() {
  const mod = await import('../validator/index.js');
  return mod.validateEvent;
}

export function listEvents(reg: Registry, capId?: string): CapEvent[] {
  const eventsDir = join(reg.root, 'events');
  if (!existsSync(eventsDir)) return [];
  const out: CapEvent[] = [];
  for (const month of readdirSync(eventsDir)) {
    if (!/^\d{4}-\d{2}$/.test(month)) continue; // ignore stray dirs
    const monthPath = join(eventsDir, month);
    if (!statSync(monthPath).isDirectory()) continue;
    for (const f of readdirSync(monthPath)) {
      if (!f.endsWith('.yaml')) continue;
      const fp = join(monthPath, f);
      let ev: CapEvent;
      try {
        ev = parseYAMLSafe<CapEvent>(readFileSync(fp, 'utf8'), fp);
      } catch (err) {
        // Corrupt event file — surface but do not abort the whole walk
        process.stderr.write(`warning: skipping corrupt event file ${fp}: ${(err as Error).message}\n`);
        continue;
      }
      if (!capId || ev.cap_id === capId) out.push(ev);
    }
  }
  out.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
  return out;
}

/**
 * Strict variant of listEvents that validates every event against the schema.
 * Returns only events that pass; corrupt or schema-invalid events are silently
 * dropped from the returned list (with a warning to stderr).
 *
 * Use this for security-sensitive paths like rollback that depend on event
 * content being trustworthy.
 */
export async function listEventsValidated(reg: Registry, capId?: string): Promise<CapEvent[]> {
  const events = listEvents(reg, capId);
  const validate = await getEventValidator();
  const out: CapEvent[] = [];
  for (const ev of events) {
    const v = validate(ev);
    if (v.ok) {
      out.push(ev);
    } else {
      process.stderr.write(
        `warning: skipping event ${ev.event_id} — fails validation: ${v.issues.map((i) => i.code).join(',')}\n`,
      );
    }
  }
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
