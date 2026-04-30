# Security Policy

## Reporting a vulnerability

Please email **security@webspot.me** with details. Do NOT open a public issue.

We aim to acknowledge within 72 hours and provide a remediation timeline within 7 days.

## Scope

In-scope:
- The `cap-protocol` npm package (this repository)
- The schema files in `schema/`
- The reference CLI `cap`

Out-of-scope:
- Bugs in dependencies (please report upstream and notify us)
- Vulnerabilities introduced by users storing secret material in registry files (this is a misuse — see below)

## Trust boundaries

A registry is a **declaration** of what an agent claims to have access to. The registry itself does NOT grant access; access is granted by the underlying systems (OS, MCP servers, OAuth grants, etc.).

An attacker who controls the registry can mislead the agent's planner — but cannot directly invoke capabilities not granted by the underlying systems.

## Secret hygiene

Resource files MUST NOT contain secret material. The validator includes a pre-commit secret scan covering common patterns (AWS keys, GitHub tokens, OpenAI/Anthropic API keys, JWT, private key blocks). Operators are responsible for layering additional scanning (`gitleaks`, `trufflehog`, etc.) on their registry repositories.

## Threat model

See [SPEC.md §5](SPEC.md#5-threat-model-and-security-considerations).
