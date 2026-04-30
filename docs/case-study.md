# Case study: scaling a capability registry to 3,000+ entries

This case study describes the practical experience that motivated cap-protocol. Specific service names, account identifiers, and source paths have been abstracted; the numbers are real.

## The system

A long-running Claude Code-style agent connected to:
- 30+ Claude Code native tools (Read, Write, Bash, Edit, Glob, Grep, Agent, Skill, plus deferred tools like ScheduleWakeup, CronCreate, etc.)
- ~270 tools from 50+ MCP servers (filesystem, fetch, postgres, sqlite, github, browser automation, payment, email, voice, image generation, search, scheduling, etc.)
- ~165 skills (PDF processing, spreadsheets, branding, design, integration helpers, debugging recipes)
- ~58 slash commands and ~240 sub-agents (active and archived)
- Hundreds of server-module functions, scripts, microservices, cron jobs, systemd units, Docker containers
- ~190 API-key-unlocked surfaces (third-party integrations across payment, communication, social, design, voice, transcription, search, etc.)

Total: **3,065 capabilities across 38 layers.**

## The pre-protocol pain

Before adopting cap-protocol's structure (when capabilities lived in a flat 22,000-line markdown file):

- **Onboarding new capabilities took ~20 minutes** of manual editing per capability — find the right section, copy the format, hope you didn't typo a field.
- **Capability drift was invisible.** When a third-party integration deprecated an endpoint, the registry kept saying `status: active`. The first signal was a user-facing failure.
- **Refresh was destructive.** `regenerate-capabilities.sh` rewrote the entire file, erasing any contextual comments, partial changes, and unreviewed additions.
- **No rollback.** When a refresh introduced a bad entry, the only recovery was `git reset --hard` — which lost any other changes made in the interim.
- **Audit was forensic.** "Was this capability registered when the bug happened?" required a `git log` walk and manual cross-reference with logs.

## What changed

After migrating to cap-protocol structure:

| Metric | Before | After |
|---|---|---|
| Capability registration time | ~20 min manual | ~30 sec via `cap propose --from-file` |
| Drift detection | reactive (user-facing failure) | proactive (`cap verify` cron) |
| Refresh granularity | whole-file rewrite | per-capability propose/assess/commit |
| Rollback granularity | git reset (lossy) | per-event rollback (lossless) |
| Audit query "what was active on date X?" | ~10 min forensic | `cap history <id> --at <date>` (sub-second) |
| Registry file count | 1 monolithic | 3,065 per-resource YAMLs + event log |
| Refresh duration | 4-7 minutes for full regen | 50-200ms per capability change |

## Lessons

1. **The migration was reversible.** During a 7-day soak the flat file remained the source of truth; the new registry was a parallel mirror. When we caught a schema edge case (the `archived` state needed an explicit transition path back to `active` for un-deprecation rollbacks), we fixed it in the schema and the migration script, then re-ran. Zero production impact.

2. **The pre-commit secret scan caught real leaks.** During the migration, two CAP_IDs had partial API key fragments embedded in the `source` field (left over from a copy-paste during initial registration). The pattern scanner flagged them at `assess` time before the `commit` phase. Both were rotated and re-registered with proper env-var references.

3. **The state machine prevented bad transitions.** Several proposals attempted to transition resources directly from `proposed` to `active` (a refresh shortcut). The FSM rejected them with a clear error pointing to the missing `verified` step.

4. **Per-capability semver pays off slowly but durably.** The first time an MCP server's API broke and we said "the v2.0.0 entry is failing health checks; transition to `degraded` and roll back the agent's bound version to v1.5.3" was the moment the version field stopped feeling like ceremony.

5. **Public registries need stricter hygiene than private ones.** When we considered open-sourcing the registry, the secret scan caught a long tail of soft-PII (email addresses in `account` fields, server hostnames in `source` paths) that was acceptable for an internal artifact but unacceptable for a public one. The `--strict-pii` flag exists because of that audit.
