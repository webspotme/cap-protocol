# cap-protocol Specification (v0.1)

> **Status**: Draft. Stable for v0.x line. Breaking changes will be marked `BREAKING` in CHANGELOG.

## 1. Overview

cap-protocol defines:

1. **RSPL** — *Resource Substrate Protocol Layer*: how individual capabilities are registered, described, and addressed.
2. **SEPL** — *Self-Evolution Protocol Layer*: how capabilities transition through their lifecycle via auditable, reversible operations.

Both layers are deliberately decoupled: **what** evolves vs **how** evolution occurs.

The protocol is implementation-agnostic. The reference implementation in this repository is in TypeScript; adapters in other languages should preserve the schemas and operator semantics defined here.

## 2. RSPL — Resource Substrate Protocol Layer

### 2.1 Resource

A **Resource** is the unit of registration. It represents one capability (a tool, prompt, sub-agent, memory store, integration, access privilege, etc.).

#### 2.1.1 Required fields

| Field | Type | Description |
|---|---|---|
| `cap_id` | string | Globally unique. Lowercase, underscore-separated. Pattern: `^[a-z][a-z0-9_]{1,127}$` |
| `schema_version` | integer | Resource schema version. Currently `1`. |
| `layer` | enum | One of: `cc-native`, `mcp`, `skill`, `slash-command`, `subagent`, `delegate`, `server-module`, `server-script`, `cli-tool`, `microservice`, `systemd`, `docker`, `cron`, `api-key-unlock`, `access`, `memory`, `model-access`, `knowledge-base`, `identity-surface`. Implementations MAY define additional layers. |
| `source` | string | Resolvable identifier (file path, MCP server.tool, container name, etc.). |
| `what` | string | One-line description. Max 200 chars. |
| `account` | string | Identity acting under this capability, or `N/A`. |
| `state` | object | See §2.2 |
| `lifecycle` | object | See §2.3 |
| `version` | string | Semver `MAJOR.MINOR.PATCH`. |

#### 2.1.2 Optional fields

| Field | Type | Description |
|---|---|---|
| `interface` | object | `{inputs, outputs, side_effects}` — schema of the capability's interface |
| `constraints` | object | `{HARD?, rate_limit?, account_lock?}` |
| `provenance` | object | `{added_by, evidence}` — who/what added this resource |
| `related` | object | `{composes_with[], superseded_by, supersedes}` |
| `tags` | string[] | Free-form tags |

### 2.2 State (the runtime status of a resource)

```yaml
state:
  current: active     # see §2.4
  since: <ISO-8601>
  health: green       # green | yellow | red
  last_verified: <ISO-8601>
  verifier: <string>  # operator or tool that performed last verification
```

### 2.3 Lifecycle (the historical timeline)

```yaml
lifecycle:
  proposed_by: <string>
  proposed_at: <ISO-8601>
  registered_at: <ISO-8601>
  verified_at: <ISO-8601 | null>
  activated_at: <ISO-8601 | null>
  deprecated_at: <ISO-8601 | null>
  archived_at: <ISO-8601 | null>
```

### 2.4 Lifecycle State Machine

```
  proposed ──verify──▶ registered ──verify──▶ verified ──activate──▶ active
                          │                                            │
                          ▼                                            ▼
                       rejected                                    degraded
                                                                       │
                                                                  ┌────┼────┐
                                                                  ▼         ▼
                                                              recovered  deprecated
                                                                            │
                                                                            ▼
                                                                         archived
```

| State | Meaning |
|---|---|
| `proposed` | Discovered by `propose` phase; not yet validated |
| `registered` | Schema validates, `source` resolves; behavior not yet checked |
| `verified` | Behavior check passed (one successful invocation or witness trace) |
| `active` | Currently usable. Default healthy state. |
| `degraded` | Health check fails but resource not removed (e.g., MCP server returning 503) |
| `recovered` | Transient state; auto-transitions back to `active` after consecutive green checks |
| `deprecated` | Superseded; still callable; will be archived after grace window |
| `archived` | Removed from active surface; retained for historical lineage only |
| `rejected` | Failed validation; will not be activated. Retained for audit. |

State transitions MUST be effected via a SEPL operation (§3) to ensure auditability.

### 2.5 Versioning

- Per-resource semver in the `version` field.
- **MAJOR** bump = breaking interface change (input/output shape).
- **MINOR** bump = additive (new optional input, new sub-tool exposed).
- **PATCH** bump = behavior fix without interface change.
- Registries MUST track the registry-level semver in a `HEAD` file in the registry root.

### 2.6 Storage

- Resources MUST be stored as YAML files at `resources/<cap_id>.yaml` within the registry root, one resource per file.
- Manifests MAY be stored at `manifests/<layer>.yaml` as a per-layer index. Manifests are derived; they are not source of truth.
- Events MUST be stored at `events/YYYY-MM/<ISO-timestamp>_<cap_id>_<event_kind>.yaml`. Events are append-only; mutation is not permitted (see §3.4).

## 3. SEPL — Self-Evolution Protocol Layer

### 3.1 Operator phases

Every change to the registry passes through a four-phase pipeline:

1. **propose** — produce a proposed delta against current state. No side effects on the live registry.
2. **assess** — validate the proposal: schema, references, behavior probes. No side effects on the live registry.
3. **commit** — apply the proposal: write resource files, append event log entries, bump HEAD.
4. **rollback** — undo a previously committed event by writing a counter-event that restores the prior resource state.

### 3.2 Event record

Every transition writes one Event record:

```yaml
event_id: <ISO-timestamp>_<cap_id>_<phase>
schema_version: 1
cap_id: <string>
operator: <string>
phase: propose | assess | commit | rollback
result: pass | fail | warn
delta:
  before: <object — fields changed>
  after: <object — new values>
trace:
  validator_run_id: <string>
  evidence_files: <string[]>
auditable: true
parent_event: <event_id | null>   # for rollback events
```

### 3.3 Required guarantees

A conforming implementation MUST guarantee:

- **G1 (Atomicity)** — A `commit` phase that fails partway leaves the registry in its pre-commit state. Implementations MAY use a staging directory + atomic rename; alternatives MUST achieve equivalent effect.
- **G2 (Auditability)** — Every state transition has a corresponding Event record. The lifecycle field of any resource is reproducible by replaying its events.
- **G3 (Reversibility)** — For every committed event there exists a `rollback` operation that restores the prior state of the affected resource(s) and writes a counter-event with `parent_event` pointing to the original.
- **G4 (Append-only events)** — Event files MUST NOT be modified or deleted in normal operation. Garbage collection of archived events MAY occur after a grace period, but MUST be performed by a documented `gc` operation that itself produces an event.

### 3.4 Optional capabilities

Implementations MAY provide:

- **Optimizer slot** — a pluggable hook that consumes events and proposes follow-up changes. cap-protocol does not specify the optimizer; implementations are free to use reflection, RL (e.g., AGP's GRPO), human review, or none.
- **Notifier slot** — a hook that publishes events to external sinks (Slack, webhook, etc.) at commit time.

## 4. Conformance

### 4.1 Schema compliance

Implementations MUST validate resources against `schema/resource.schema.json` and events against `schema/event.schema.json`. Both are normative and shipped with the protocol.

### 4.2 CLI surface (recommended, not required)

Reference implementations SHOULD expose:

| Command | Effect |
|---|---|
| `cap init <path>` | Initialize empty registry |
| `cap propose --id <id> ...` | Create a proposal |
| `cap assess <run-id>` | Validate a proposal |
| `cap commit <run-id>` | Apply a proposal |
| `cap rollback <event-id>` | Undo a committed event |
| `cap show <id>` | Print current resource |
| `cap history <id>` | Print event timeline |
| `cap history <id> --at <ISO>` | Reconstruct resource state at a point in time |
| `cap list [--layer X] [--state Y]` | List resources |
| `cap verify [<id>...]` | Run health probes |

### 4.3 Capability planner contract

cap-protocol does not specify the agent's planner. However, agents that consume a cap-protocol registry SHOULD:

- Filter to resources where `state.current ∈ {active, degraded}` for runtime decisions.
- Surface `state.health` to the user when `degraded`.
- Treat `deprecated` capabilities as last-resort fallbacks; emit a warning when used.
- Treat `archived` capabilities as unavailable.

## 5. Threat model and security considerations

### 5.1 Trust boundaries

- A registry is a **declaration** of what an agent claims to have access to. The registry itself does NOT grant access. Access is granted by the underlying systems (OS, MCP servers, OAuth grants, etc.).
- Therefore, an attacker who controls the registry can mislead the agent's planner into believing capabilities exist or do not exist, but cannot directly invoke capabilities not granted by the underlying systems.

### 5.2 Required handling of secrets

- Resource files MUST NOT contain secret material (API keys, passwords, tokens). The `source` field MAY reference a secret store entry (e.g., `env::ANTHROPIC_API_KEY`) but MUST NOT contain the secret value.
- Implementations SHOULD validate this at `assess` time using a regex pre-pass (the reference implementation's `secrets-precheck` module is shipped as a starting point).

### 5.3 Recommended hygiene

- Registries SHOULD be stored under version control with branch protection.
- The `commit` operator SHOULD require signed-off-by metadata in deployment scenarios.
- Public registries SHOULD NOT include resources with `account` fields naming individuals or private organizations; use abstract roles (e.g., `service-account`) instead.

## 6. Versioning of this specification

This document is `v0.1`. Subsequent revisions will be tagged `vMAJOR.MINOR` and listed in `CHANGELOG.md`. The `schema_version` field of resources and events tracks schema-breaking changes independently from this document.

## 7. References

1. Wentao Zhang et al. *Autogenesis: A Self-Evolving Agent Protocol*. arXiv:2604.15034, 2026.
   The two-layer architecture (RSPL/SEPL) and the propose/assess/commit operator vocabulary in cap-protocol are derived from this work. cap-protocol is a practitioner-focused subset that omits the closed-loop optimizer layer (`Act/Observe/Optimize/Remember`).
2. Anthropic. *Model Context Protocol (MCP)*. https://modelcontextprotocol.io/, 2025.
3. Google. *Agent2Agent (A2A) Protocol*. 2025.
