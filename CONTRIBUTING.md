# Contributing to cap-protocol

Thanks for considering a contribution!

## Quick start

```bash
git clone https://github.com/webspotme/cap-protocol.git
cd cap-protocol
npm install
npm test
npm run build
```

## Ground rules

1. **Schema is normative.** Changes to `schema/resource.schema.json` or `schema/event.schema.json` require:
   - A `BREAKING` note in CHANGELOG.md if the change rejects previously-valid records
   - Bumping the relevant `schema_version` constant in `src/models/types.ts`
   - Updating `SPEC.md` to match
2. **Tests are required.** New code paths need tests in `tests/`. Run `npm test` locally before opening a PR.
3. **No secret material in test fixtures.** Use documented EXAMPLE keys (AWS provides `AKIAIOSFODNN7EXAMPLE`) or hand-crafted obviously-fake patterns. The repo's `.gitleaks.toml` allowlists known fixtures; add yours there if needed.
4. **Pre-commit secret scan.** Install `gitleaks` locally and run `gitleaks detect --no-banner` before pushing.
5. **Example registries are validated with `--strict-pii`.** Anything under `examples/*/` is run through `scripts/validate-registry.mjs` in CI with strict PII pattern matching enabled. Use abstract identifiers (`service-account`, `org-account`) rather than personal emails or named individuals.
6. **Lockfile.** `package-lock.json` is committed; CI uses `npm ci` for reproducibility. If you add or update a dependency, commit the resulting lockfile change in the same PR.

## Pull request checklist

- [ ] Tests added or updated
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] CHANGELOG.md updated for any user-visible change
- [ ] If schema changed: SPEC.md updated, schema_version bumped, migration note added

## Reporting security issues

Please do NOT open a public issue. Email security@webspot.me with details. We aim to acknowledge within 72 hours.

## Conduct

Be kind. Be clear. Disagree productively. Bullying, harassment, or discrimination of any kind is not tolerated.
