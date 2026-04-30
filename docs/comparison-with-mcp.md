# cap-protocol and MCP

cap-protocol is **complementary** to MCP. They live at different layers and solve different problems.

## What MCP gives you

- A wire protocol for an agent to discover and invoke tools exposed by a server.
- A `tools/list` endpoint that returns names + JSON Schemas of what's available right now.
- A standardized request/response format for tool calls.

## What MCP does NOT give you

- A version on each tool. (`tools/list` returns names and schemas; if a server changes, the agent has no way to know whether it's v1 or v2.)
- A lifecycle. (A tool either appears in `tools/list` or doesn't. There's no "deprecated", no "degraded".)
- An audit trail. (When did this tool first appear in the registry? When did it stop working?)
- A representation for non-MCP capabilities. (Native CC tools, skills, sub-agents, scheduled jobs, OAuth-granted surfaces.)

## How cap-protocol layers atop MCP

cap-protocol's `mcp` layer is one of many layer values. An MCP-served tool gets a `cap_id` in the registry alongside CC-native tools, skills, etc.:

```yaml
cap_id: mcp_postgres_query
schema_version: 1
layer: mcp
source: modelcontextprotocol/servers#postgres.query
what: Execute read-only SQL via the postgres MCP
account: service-account
state:
  current: active
  since: 2026-04-30T00:00:00Z
  health: green
  last_verified: 2026-04-30T07:42:00Z
  verifier: cap-cli
lifecycle:
  proposed_by: registry-admin
  proposed_at: 2026-04-30T00:00:00Z
  registered_at: 2026-04-30T00:00:00Z
  verified_at: 2026-04-30T00:00:00Z
  activated_at: 2026-04-30T00:00:00Z
version: 1.0.0
```

When the MCP server bumps its API, the registry can:
1. `propose` a v2.0.0 entry alongside the v1.0.0 entry.
2. `assess` it: schema valid, `source` resolves, behavior probe passes.
3. `commit` it. The v1 entry transitions to `deprecated`, the v2 entry to `active`.
4. Roll back if v2 turns out to be broken.

The agent's planner sees the lifecycle metadata and routes accordingly.

## Recommended pattern: MCP discovery, cap-protocol registry

Run a periodic job that:
1. Calls `tools/list` on every connected MCP server.
2. Diffs against the cap-protocol registry.
3. For each new tool: emit a `propose` event.
4. For each removed tool: emit a `propose` event with state transition `active → degraded` or `active → archived`.
5. The job's results land in `proposals/`. A human (or an automated `assess` + `commit`) decides what to apply.

This pattern preserves MCP's strengths (low-friction tool exposure, standard wire protocol) while adding the version, lifecycle, and audit guarantees that production agent systems need.
