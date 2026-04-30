# Changelog

## v0.1.0 (unreleased)

Initial release.

- Protocol specification (`SPEC.md`)
- JSON Schema for resources and events (`schema/`)
- TypeScript reference implementation (npm package: `cap-protocol`)
- CLI: `cap init / propose / assess / commit / rollback / show / history / list / head`
- Built-in pre-commit secret-pattern scanner (AWS, GitHub, OpenAI, Anthropic, Slack, Stripe, Google API, JWT, private key blocks, high-entropy base64)
- Optional PII pattern scanner for public registries (`--strict-pii`)
- Public example registry under `examples/example-registry/`
- CI: typecheck, lint, tests on Node 20 + 22, gitleaks secret scan, schema validation against example registry

### Pre-release hardening (after independent security reviews)

**Atomicity & correctness (Codex critical):**
- `commit` is now transactional: append the commit event with `O_CREAT|O_EXCL` first (G1), then atomic same-directory rename of the resource file, then bump `HEAD`. The event log is the source of truth; resource files are a materialized cache. Documented in SPEC §3.1 and §3.3.
- `appendEvent` uses `wx` (exclusive create) instead of `existsSync + rename` — closes the TOCTOU race that allowed event-log overwrites under concurrent writers.
- Same-millisecond collisions now fall back to a counter-suffix file naming scheme (up to 1000 attempts before failing).
- `rollback` of a creation commit deletes the resource file (matches `reconstructAt` returning null at that point in the timeline) instead of writing an `archived` resource. Documented as G3.
- `commit` now bumps `HEAD` to the resource's version if it is higher than the current `HEAD`.

**Tamper detection (Codex high):**
- New `listEventsValidated` reader that validates every event against the schema before honoring it. Replay (`reconstructAt`) and `rollback` use the validated reader. Tampered events are dropped with a warning.
- `rollback` additionally validates the embedded `delta.before` against the Resource schema before writing it back as a Resource.

**Path-escape hardening (Codex high):**
- `openRegistry` now refuses if any of `resources/`, `events/`, `manifests/`, `proposals/` is a symlink.
- `appendEvent` validates the `cap_id`, `phase`, and `YYYY-MM` month-directory components and uses an internal `assertWithinRegistry` containment check.

**Schema correctness (Codex medium):**
- Resource schema now enforces lifecycle timestamps conditional on `state.current` via `allOf`/`if`/`then` — e.g., `state.current: active` requires `lifecycle.activated_at`.
- Event schema requires `timestamp` (was optional) and constrains `auditable: const true` (was loose boolean).
- `interface.inputs` / `interface.outputs` are bounded (max props, max length).

**CLI & DX:**
- `cap verify` command added (was advertised in SPEC §4.2 but unimplemented).
- README examples now include `--root` flags everywhere.
- `cap propose --from-file` uses the top-level ESM `parseYAML` import and rejects files >5 MB.
- `assess` / `commit` / `verify` default to `--strict-pii=on`; pass `--no-strict-pii` to disable.

**Hygiene:**
- Tightened gitleaks allowlist — removed the `paths = ['''tests/.*''']` blanket exemption; only specific fake-key regexes are allowed.
- CI: switched `npm ci` to `npm install --no-audit --no-fund` for pre-lockfile bootstrap; CONTRIBUTING.md documents the lockfile workflow.
- GitHub Actions pinned to commit SHAs for supply-chain hardening.
- Stale `*.tmp.<pid>.<ts>` files older than 1 hour are swept on `openRegistry`.

**Privacy:**
- `docs/case-study.md` rewritten as fully synthetic — removed all references to specific operational metrics, capability counts, and migration-incident narrative.
- `docs/motivation.md` "Real-world scale" section generalized.

**Tests added:**
- 13 FSM transition tests (covers all allowed `proposed → registered → verified → active → degraded/recovered/deprecated → archived` plus rejected paths).
- Path-traversal hardening tests.
- Creation-rollback semantics test (live state matches replay state).
- HEAD bump test.
- appendEvent collision-avoidance test.
- Schema bounds tests for `interface.inputs/outputs`.

### Post-Gemini-review patch

- **CRITICAL (G2 audit gap):** `rollback()` now appends the rollback event BEFORE materializing the prior state (mirroring the `commit()` ordering). Previously the resource was written/unlinked first, leaving an audit gap if `appendEvent` failed. Added regression test that asserts the rollback event is durably on disk.
- **Schema lifecycle gaps:** `degraded` and `recovered` states now require the same lifecycle timestamps as `active` (proposed_at / registered_at / verified_at / activated_at). `deprecated` additionally requires the activation history. Closes a Medium finding from Gemini.
- **SPEC diagram:** Added the `deprecated → active` (un-deprecate) edge to SPEC §2.4 to align with the implementation's `ALLOWED_TRANSITIONS`.

**Known limitations carried into v0.1.0:**

- `listEventsValidated` performs O(N) walk + validation across all events for `rollback` and `reconstructAt`. Acceptable for the v0.1 target scale (hundreds–low-thousands of resources). Future iterations should filter by `cap_id` at the filesystem level. (Gemini Minor #4 — graded acceptable for v0.x.)
- Transitive dev-only CVE: GHSA-67mh-4wv8-2f99 in `esbuild` via `vitest@^2.1.0`. Dev-time only (not in `files` allow-list, not shipped to consumers). Tracked for vitest 4.x upgrade post-v0.1.0. (CSO Medium #2.)
- v0.1.0 ships without a committed `package-lock.json`. CI uses `npm install --no-audit --no-fund` until a lockfile lands; CONTRIBUTING.md documents the workflow. (CSO Medium #1, partial.)

### Post-Gemini-round-4 patch (one bonus pre-existing finding)

- **Pre-existing minor:** `package.json` `smoke` script and `release.yml` smoke step both used CommonJS `require()` in a package marked `"type": "module"` — would have failed `prepublishOnly`. Switched both to `node --input-type=module -e "import(...)"`. Pre-existing from the original round-3 release-workflow addition, not introduced by any patch round.

### Post-Codex-round-4 patch

- **HIGH (recovery uses unvalidated event reader):** `reconcileFromEventLog` now filters every event through `validateEvent` before honoring it, satisfying SPEC G5. Tampered/malformed events are dropped with a stderr warning instead of being trusted by the recovery materializer.
- **MEDIUM (cross-cap_id materialization):** Recovery, `reconstructAt`, and `rollback` now refuse any event whose embedded `delta.after.cap_id` (or `delta.before.cap_id`) doesn't match the event's own `cap_id` field. Closes a hijack vector where a tampered commit event for cap_id=X could overwrite resource Y on recovery.
- **LOW (SPEC G1 wording):** SPEC §3.3 G1 updated to match the post-round-3 opt-in recovery design — recovery may be invoked on demand via `cap verify --recover`, but consumers operating on a registry of unknown state MUST run recovery before any read.
- **INFO:** Added regression tests: `recoverRegistry` reconciles a torn-write deleted resource; recovery refuses tampered cap_id-mismatch events.

### Post-Gemini-round-3 patch

- **HIGH (cache-poisoning fail-open):** `reconcileFromEventLog` previously used CommonJS `require()` which is undefined in this ESM project. The validator load silently failed and recovery materialized embedded resource snapshots WITHOUT validation — exactly the fail-open Codex round 2 P1 #2 was meant to close. Switched to dynamic `await import('../validator/index.js')`, made `reconcileFromEventLog` and the new public `recoverRegistry` async.
- **MEDIUM (O(N) cost on every CLI invocation):** Recovery is no longer automatic on `openRegistry`. It is now opt-in via `cap verify --recover` (CLI) or `await recoverRegistry(reg)` (library). Documentation: SPEC §3.3 G1 acknowledges that recovery is on-demand; library consumers SHOULD call `recoverRegistry` on a registry of unknown state before any read.
- **LOW (rollback unlinkSync race):** Creation rollback now uses a try/catch with ENOENT tolerance instead of `existsSync` + `unlinkSync`. Closes the race with a concurrent recovery pass that may have already removed the file.
- **MINOR (unstable sort):** `listEvents` now sorts by `(timestamp, event_id)` as a stable tiebreaker for events that share a millisecond.

### Post-Codex-round-2 patch

- **P1 #1 (recovery from event log on open):** `openRegistry` now runs a torn-write reconciliation pass — replay commit/rollback events oldest-to-newest, validate each embedded resource, and align the materialized cache with the event log. Closes the gap where a crash between `appendEvent` and `writeResource` would leave `readResource`/`cap show` returning stale data forever. Pass `{ skipReplay: true }` to opt out (e.g., for migration tooling).
- **P1 #2 (validate embedded resource deltas):** `reconstructAt` now validates `delta.after` against the Resource schema before treating it as trusted. A schema-valid event with a tampered embedded resource no longer corrupts replay output.
- **P2 #3 (event_id unique under collisions):** When `appendEvent` retries with a counter suffix on filename collision, the suffix is also baked into the on-disk `event_id` so two events on disk cannot share a logical ID.
- **P2 #4 (recursive symlink rejection):** `listEvents` now refuses symlinked month directories and event files. Previously only top-level registry subdirs were checked.
- **P2 #5 (non-null lifecycle timestamps):** Schema `allOf`/`if`/`then` rules now require non-null `date-time` values (not just key presence) for the lifecycle timestamps each state requires, plus `state.last_verified` for `active` resources.

### Post-CSO-review patch

- **HIGH:** `gitleaks-action` SHA pin comment corrected from `# v2.3.7` to `# v2.3.9` (the SHA is correct; only the human-readable comment was wrong, which would have masked future drift).
- **MEDIUM:** Added `.github/workflows/release.yml` — tag-triggered npm publish with `--provenance` (sigstore attestation), `id-token: write` permission, `production` GitHub environment for manual approval, smoke test that the built `dist/` actually loads, and tag-vs-package-version equality check.
- **MEDIUM:** Added `npm run smoke` script (`node -e "require('./dist/index.js')"`) and chained it in `prepublishOnly` so manual publishes from a laptop also catch the dist/-not-built case.
- **MEDIUM:** Added `.github/dependabot.yml` — weekly npm + github-actions updates, grouped by dev/runtime.
- **INFO → SPEC §5.4:** Added explicit threat-model coverage for `cap_id` collision/typosquatting, YAML loader hardening, and schema poisoning (consumers MUST NOT fetch schema from the registry they are validating).
