# cap-protocol

> The capability registry layer between MCP and the agent's planner.

[![npm version](https://img.shields.io/npm/v/cap-protocol.svg)](https://www.npmjs.com/package/cap-protocol)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/webspotme/cap-protocol/actions/workflows/ci.yml/badge.svg)](https://github.com/webspotme/cap-protocol/actions)

## What it is

A protocol and reference implementation for **registering, versioning, and evolving** the capabilities an AI agent can use — tools, prompts, sub-agents, memory stores, integrations.

Today, agent systems built on MCP and A2A turn into spaghetti: flat lists of tools with no version, no lifecycle, no audit trail. When something breaks you can't tell when it broke, why, or how to roll back. cap-protocol gives those resources a state machine and an append-only event log.

## What it solves

| Today | With cap-protocol |
|---|---|
| `status: active` is the only field | `state` is a finite-state machine: `proposed → registered → verified → active → degraded → deprecated → archived` |
| No version per capability | Every resource has a semver `version` and a versioned `interface` |
| Capability list regenerated wholesale | `propose → assess → commit → rollback` per change, append-only event log |
| "Was this tool working last Tuesday?" → git blame | One CLI query: `cap history <id> --at 2026-04-22` |

## 30-second example

```bash
npm install -g cap-protocol

# Initialize a registry
cap init my-agent-registry

# Propose a new capability
cap propose --root my-agent-registry \
  --id tool_read \
  --layer cc-native \
  --source Read \
  --what "Read files from local filesystem"
# → prints a run-id, e.g. 2026-04-30T07-42-00-000Z_a1b2c3d4

# Validate the proposal (no side effects)
cap assess --root my-agent-registry <run-id>

# Commit it (writes resource + event log entry)
cap commit --root my-agent-registry <run-id>

# Inspect
cap show --root my-agent-registry tool_read
cap history --root my-agent-registry tool_read

# Verify the whole registry against schema + secret/PII patterns
cap verify --root my-agent-registry

# Roll back if needed
cap rollback --root my-agent-registry <event-id>
```

## How it relates to MCP / A2A / AGP

- **MCP** says "here are the tools you can call right now." Anthropic owns this.
- **A2A** says "here is how agents talk." Google owns this.
- **AGP** ([Zhang et al. 2026](https://arxiv.org/abs/2604.15034)) says "here is how agents evolve themselves." Academic, no widely-adopted implementation.
- **cap-protocol** says "here is how an agent **knows what it can do** and **proves it**" — the registry layer between MCP and the agent's planner.

cap-protocol is a **practitioner subset** of AGP: it adopts AGP's two-layer split (resource substrate + closed-loop evolution) but drops the RL-style optimizer layer. It's the bookkeeping discipline you can drop into any agent system today.

See [`docs/comparison-with-agp.md`](docs/comparison-with-agp.md) for the formal mapping.

## Architecture

```
┌──────────────────────────────────────────────────┐
│  Agent Planner ("which capability do I use?")    │
│                       │                          │
│                       ▼                          │
│  cap-protocol Registry                           │
│  ├── resources/<id>.yaml  ← versioned, stateful  │
│  ├── events/YYYY-MM/...   ← append-only log      │
│  └── manifests/<layer>.yaml                      │
│                       │                          │
│                       ▼                          │
│  MCP / Native Tools / Sub-Agents                 │
└──────────────────────────────────────────────────┘
```

## Documentation

- [`SPEC.md`](SPEC.md) — the protocol specification (RSPL + SEPL, lifecycle FSM, event format)
- [`docs/motivation.md`](docs/motivation.md) — why flat capability lists break down at scale
- [`docs/comparison-with-mcp.md`](docs/comparison-with-mcp.md) — how cap-protocol layers atop MCP
- [`docs/comparison-with-agp.md`](docs/comparison-with-agp.md) — what we kept, simplified, changed
- [`docs/case-study.md`](docs/case-study.md) — bringing cap-protocol to a 3,000+ capability agent system
- [`examples/example-registry/`](examples/example-registry/) — example registry of public CC-native and MCP tools

## Status

**v0.1** — protocol spec frozen, TypeScript reference implementation, public example registry. Production agents experimenting in private registries. API surface stable for the v0.x line; semver discipline starts at v1.0.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and PRs welcome — especially around schema edge cases, additional example registries from real agent systems, and adapter packages for Python / Go.

## Citation

If cap-protocol helps your research or product, please cite:

```bibtex
@software{webspot2026capprotocol,
  title  = {cap-protocol: A Capability Registry Layer for AI Agents},
  author = {Webspot},
  year   = {2026},
  url    = {https://github.com/webspotme/cap-protocol}
}
```

And cite the AGP paper that inspired the two-layer architecture:

```bibtex
@misc{zhang2026autogenesisselfevolvingagentprotocol,
  title         = {Autogenesis: A Self-Evolving Agent Protocol},
  author        = {Wentao Zhang and Zhe Zhao and Haibin Wen and Yingcheng Wu and
                   Ming Yin and Bo An and Mengdi Wang},
  year          = {2026},
  eprint        = {2604.15034},
  archivePrefix = {arXiv},
  primaryClass  = {cs.AI}
}
```

## License

[MIT](LICENSE)
