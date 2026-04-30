# Why a capability registry?

Every modern AI agent system has the same hidden file: a long list of "tools the agent can call." Sometimes it's a YAML config. Sometimes it's an MCP `tools/list` response. Sometimes it's a hand-written prompt section. They all share three problems.

## Problem 1: Flat lists do not scale

A small agent with 12 tools fits in your head. A real production agent — Claude Code with skills, MCP servers, sub-agents, scheduled jobs, OAuth-connected services — easily has 200, 500, 3,000+ capabilities.

When the list is flat (`status: active` for everything, no version, no health), the agent's planner has no way to filter. So you get one of:
- **Over-listing** → the planner is shown all 3,000 capabilities, drowns in choice, and picks badly.
- **Under-listing** → the system maintains a hardcoded subset, and the planner never sees newer capabilities until someone manually adds them.

Recent academic work ([Su et al. 2026, *Skill Retrieval Augmentation*](https://arxiv.org/abs/2604.24594)) confirms this: agents load skills at similar rates regardless of whether the right skill was retrieved. The bottleneck isn't *what's available* — it's *what state the agent believes each capability is in*.

## Problem 2: No version means no migration

When an MCP server bumps its API, or a skill is rewritten, or a tool is replaced, today's flat lists silently update. The agent that worked yesterday breaks today, and there's no signal.

Per-capability semver gives the planner three useful behaviors:
- Detect breaking changes (`MAJOR` bump) and warn the user before invoking.
- Hold compatibility shims (a v1 wrapper around v2) for graceful migration.
- Pin to known-good versions when stability matters more than newness.

## Problem 3: No audit trail means no recovery

Production agents fail. When they do, the on-call response always starts with: "what changed?"

A capability registry without an audit trail can only answer that with `git log` against the config file — which conflates the *registration* of a capability with the *behavior* of the underlying system, and ignores anything that happened outside the file (an MCP server going degraded, a skill being archived, an OAuth token expiring).

cap-protocol's append-only event log captures every transition with a timestamp, a delta, and a `parent_event` pointer for rollbacks. "What was active on April 22?" becomes a one-line query.

## Where this fits

- **MCP** is the wire-protocol layer: how a tool advertises itself.
- **A2A** is the agent-to-agent layer: how two agents negotiate work.
- **cap-protocol** is the **registry layer**: how a single agent knows what it has access to and proves the state of that access over time.

These layers do not compete. They stack.

## Scale considerations

The protocol and reference implementation are designed for registries with hundreds to low thousands of resources spanning many layers (native tools, MCP servers, skills, sub-agents, scheduled jobs, integrations, access privileges).

The public example registry at `examples/example-registry/` is a small illustrative subset of public capabilities. Adopters add their own resources through the standard `propose / assess / commit` flow.
