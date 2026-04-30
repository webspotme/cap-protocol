# Case study: scaling a capability registry

This case study is **synthetic**. It illustrates the kinds of pain that motivate cap-protocol and the kinds of changes adopters typically observe. It is not a report on any specific deployment.

## The pattern

A long-running agent grows over time. It starts with a dozen native tools. Then someone adds an MCP server. Then a skill library. Then sub-agents. Then scheduled jobs. Then OAuth-connected integrations.

After a year, the "tools the agent can call" list is no longer a list — it's a small graph with hundreds of nodes across many layers (native tools, MCP-served tools, skills, sub-agents, scheduled jobs, microservices, third-party integrations, access privileges).

Without structure, the team running the agent hits a recognizable set of pains:

## Pre-protocol pain (illustrative)

- **Onboarding new capabilities is slow.** Each addition requires editing a flat config, hoping the format is right, and crossing fingers that the agent picks up the change.
- **Capability drift is invisible.** When a third-party integration deprecates an endpoint, the registry keeps reporting healthy. The first signal is a user-facing failure.
- **Refresh is destructive.** Regenerating the capability list rewrites the file, erasing contextual comments, partial changes, and unreviewed additions.
- **No rollback.** When a refresh introduces a bad entry, recovery means `git reset --hard` — which loses any other in-flight changes.
- **Audit is forensic.** "Was this capability registered when the bug happened?" requires a `git log` walk and manual cross-reference.

## With cap-protocol (illustrative)

| Concern | Before | After |
|---|---|---|
| Capability registration | manual edit | `cap propose --from-file` |
| Drift detection | reactive (user-facing failure) | proactive (`cap verify` cron) |
| Refresh granularity | whole-file rewrite | per-capability propose/assess/commit |
| Rollback granularity | git reset (lossy) | per-event rollback (lossless) |
| Audit query "what was active on date X?" | git-log forensic | `cap history <id> --at <date>` |
| Registry shape | single monolithic config | per-resource files + event log |

## Lessons that tend to apply

1. **Migration is usually reversible.** A side-by-side soak — old config remains source of truth while the new registry runs in parallel — lets teams catch schema edge cases without production impact.

2. **Pre-commit secret scans catch real mistakes.** Even disciplined teams occasionally paste API key fragments into source paths during initial registration. The pattern scanner flags these at `assess` time before the `commit` phase.

3. **State machines prevent bad transitions.** Proposals that try to skip the `verified` step and transition directly from `proposed` to `active` get rejected with a clear FSM error.

4. **Per-capability semver pays off slowly but durably.** The first time you can say "the v2.0.0 entry is failing health checks; transition to `degraded` and pin the agent to v1.5.3" is the moment the version field stops feeling like ceremony.

5. **Public registries need stricter hygiene than private ones.** Patterns acceptable in a private registry (personal-style identifiers in `account` fields, hostnames in `source` paths) need abstraction before any public release. The `--strict-pii` flag exists for exactly this reason.

## Where to go from here

Adopt cap-protocol incrementally:

1. Run `cap init` in your registry directory.
2. For each capability you currently track, run `cap propose --from-file <yaml>` and `cap commit`.
3. Add `cap verify` to a daily cron.
4. Wire your agent's planner to filter on `state.current ∈ {active, degraded}`.

You don't need to migrate everything at once. The protocol is designed to be additive.
