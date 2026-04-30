# cap-protocol vs Autogenesis Protocol (AGP)

cap-protocol is a **practitioner-focused subset** of [AGP (Zhang et al. 2026)](https://arxiv.org/abs/2604.15034). This document records what was kept, what was simplified, and what was changed.

## What was kept

| AGP concept | cap-protocol | Notes |
|---|---|---|
| **Two-layer architecture** | ✅ Same: RSPL (resources) and SEPL (evolution) | Direct adoption. The decoupling of *what evolves* from *how evolution occurs* is the central insight. |
| **Resources have state, lifecycle, version** | ✅ Required RSPL fields | Same shape: `state.current`, `lifecycle.{proposed_at, registered_at, ...}`, semver `version`. |
| **Closed-loop operator** | ✅ propose → assess → commit | With rollback. cap-protocol adds `gc` as a fifth phase for documented archive cleanup. |
| **Auditable lineage + rollback** | ✅ Append-only event log | Every state transition has a corresponding Event record. Rollback writes a counter-event with `parent_event` pointer. |

## What was simplified

| AGP concept | cap-protocol | Why |
|---|---|---|
| **Closed-loop self-evolution (Act / Observe / Optimize / Remember)** | ❌ Optional, not specified | AGP is built around an academic optimizer pipeline (RL, GRPO, Reinforce++, reflection). Most practitioners want the bookkeeping discipline without the optimizer. cap-protocol exposes an **optimizer slot** but does not require one. |
| **Memory subsystem, tracing, configs** | ❌ Out of scope | Those are implementation choices for an agent runtime. cap-protocol concerns itself with the registry only. |
| **Tool / Agent / Environment as separate first-class types** | Unified into `layer` field | A 19-value enum (`cc-native`, `mcp`, `skill`, `subagent`, `delegate`, `microservice`, `cron`, `access`, ...) is more flexible than three fixed types and matches how production agent stacks are organized today. |
| **MMEngine-style config composition** | ❌ Not adopted | YAML resource files + an optional manifest are sufficient. Composition lives at the agent-runtime layer, not the registry layer. |

## What was changed

| AGP concept | cap-protocol | Why |
|---|---|---|
| **Lifecycle states** | Explicit FSM with 9 states + recovery | AGP's lifecycle is implicit. cap-protocol pins it to a documented finite-state machine (proposed → registered → verified → active → degraded → recovered → deprecated → archived; with rejected as a terminal failure). |
| **Versioning** | Per-resource semver MAJOR.MINOR.PATCH | AGP refers to versioning generically. cap-protocol picks semver to match npm/cargo/pip ecosystems. |
| **Event format** | Strict JSON Schema-validated | Enables tooling (event grep, replay, point-in-time reconstruction). |
| **Secret hygiene** | Built-in pre-commit scan | AGP doesn't address secret leakage. cap-protocol assumes registries may be public and ships pattern-based scanners for AWS/GitHub/OpenAI/Anthropic/etc. keys. |

## When to use which

- **Use AGP when** you want a research-grade self-evolving agent system with explicit optimizer pipelines and academic-style benchmarking.
- **Use cap-protocol when** you want to give an existing agent system (built on MCP, A2A, native CC tools, or a mix) a structured, versioned, auditable capability registry — without committing to a particular optimization strategy.

The two are not mutually exclusive: an AGP-style system can use cap-protocol as its `Resource Substrate` storage layer.

## Citation

If you use cap-protocol in a context where AGP comparison matters, please cite both:

```bibtex
@software{webspot2026capprotocol,
  title  = {cap-protocol: A Capability Registry Layer for AI Agents},
  author = {Webspot},
  year   = {2026},
  url    = {https://github.com/webspot/cap-protocol}
}

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
