# Example Registry: Public Tools

This directory is a **fully public, fully synthetic** example registry containing capabilities that are documented in public sources (Anthropic's tool list, MCP server READMEs, etc.).

It demonstrates the cap-protocol layout and the kinds of CAP_IDs you might register for a Claude Code-style agent.

**This is NOT a copy of any production agent's registry.** The `account` field is `service-account` everywhere; no individual or organization names appear.

## Directory layout

```
examples/example-registry/
  HEAD                         # registry semver
  resources/<cap_id>.yaml     # one resource per capability
  manifests/<layer>.yaml      # per-layer index (derived)
  events/                     # event log (empty in this example)
  schema/                     # symlinks to ../../schema/
```

## How it was generated

Run `node scripts/generate-public-example.mjs` from the repo root. The script reads the curated list of public capabilities at `scripts/public-capabilities.json` and emits one YAML file per resource into this directory.

To regenerate after adding entries to `public-capabilities.json`:

```bash
node scripts/generate-public-example.mjs
node scripts/validate-registry.mjs examples/example-registry
```

## Layers represented

- `cc-native` — Claude Code native tools (Read, Write, Bash, etc. — documented in Anthropic's CC docs)
- `mcp` — Public MCP servers (filesystem, fetch, git, github, postgres, sqlite, puppeteer)
- `skill` — Public skills shipped with Anthropic's example-skills plugin

All entries use a fictional but realistic `service-account` identity.
