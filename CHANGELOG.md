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
