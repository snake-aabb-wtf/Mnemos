# Mnemos

> A durable cognitive runtime for agents that need memory, context, tools, and operational boundaries.

[![CI](https://github.com/snake-aabb-wtf/Mnemos/actions/workflows/ci.yml/badge.svg)](https://github.com/snake-aabb-wtf/Mnemos/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Mnemos is a TypeScript-first **cognitive harness**. It gives agent applications a durable runtime around model calls:

```text
Model providers
      │
      ▼
Visible / worker agents ──► Context policy ──► bounded working context
      │                              │
      ├── Tools / PTC / discovery    ├── compaction
      ├── Memory retrieval           └── pins and pressure controls
      ├── Artifacts
      └── Multi-agent tasks
                     │
                     ▼
        Canonical History + SQLite persistence
```

The guiding rule is simple: **History is canonical; Memory, Context, indexes, and dashboards are derived.**

## What is complete

The complete backend roadmap (Phases 1–14) and frontend roadmap (F1–F6) are implemented.

| Area | Delivered |
| --- | --- |
| Runtime | Harness, append-only History, State, cancellation, lifecycle events |
| Context | Semantic compaction, pinned context, pressure levels, safe headroom, policy preflight |
| Memory | Long-term records, hybrid retrieval, source tracing, consolidation, reinforcement, decay, stale detection, merge, abstraction, entity projections |
| Data | SQLite stores, immutable Artifacts, spill/range/query APIs, migrations and index rebuilds |
| Tools | Registry, Dispatcher, permissions, structured results, audit, native tool loop, dynamic discovery |
| PTC | `run_code`, generated TypeScript SDK, RPC-only tool access, quotas, scheduler barriers, isolated subprocess backend |
| Operations | Durable jobs, worker leases, provider reliability, metrics/tracing abstractions, health/readiness, diagnostics, retention and shutdown boundaries |
| Agents | Bounded Planner/Researcher/Coder/Reviewer roles, task DAGs, delegation, handoffs, budgets, review/replan limits and recovery |
| Console | Chat, streaming, Context/Memory, Artifacts, Tools, PTC, Agents, Tasks, Dashboard and Operations views |

There is **no F7**. F6 is the final frontend milestone and Phase 14 is the final backend milestone.

## Console

The React console is a read-oriented operator and chat surface over the runtime. It never becomes a second source of truth.

- **Chat** — session switching, canonical message history, Markdown/code rendering, streaming deltas, runtime activity, Stop, retry and refresh recovery.
- **Context & Memory** — pressure and budget breakdown, pins, compaction ranges, retrieval explanations and source links back to History.
- **Artifacts, Tools & PTC** — bounded previews/ranges/queries, ToolRegistry catalog, loaded schemas, PTC timelines, barriers, quotas and spill handles.
- **Agents & Tasks** — role summaries, task states, dependencies, delegation/handoff edges and a lazy-loaded React Flow graph.
- **Dashboard & Operations** — live runtime metrics, health/readiness, workers/jobs, migrations, storage, sandbox, provider and audit summaries.

The console uses TanStack Query for server state and Zustand only for UI preferences. Recharts and React Flow are lazy-loaded. API responses are shared Zod DTOs and are bounded by design: large bodies, raw tool results, secrets, and private reasoning are not sent to the browser.

For local demo and browser tests, the server provides a deterministic in-memory adapter with no provider credentials:

```bash
pnpm install
pnpm build

# terminal 1
pnpm dev:server       # http://127.0.0.1:4317

# terminal 2
pnpm dev:console      # http://127.0.0.1:5173
```

Production composition should inject adapters backed by the real Harness, ContextManager, MemoryRetriever, ArtifactStore, ToolRegistry, PtcRuntime, task stores, MetricsSink, and diagnostics services.

More console details: [docs/console.md](docs/console.md).

## Runtime principles

### Canonical data and derived views

History is append-only and is never deleted by compaction or memory maintenance. Memory records retain ordered source references that resolve through History. Vector, FTS, entity, discovery, and dashboard projections can be rebuilt.

### One authority boundary for tools

Every native, discovered, and PTC tool call follows the same path:

```text
ToolRegistry → ToolDispatcher → permission/schema checks → timeout
             → output policy / Artifact spill → audit + lifecycle event
```

PTC receives only a generated `tools.*` SDK. It never receives a Store, Dispatcher instance, database, host filesystem, secrets, or arbitrary modules. `native`, `ptc`, and `both` exposure modes are configurable per runtime/agent.

### Bounded multi-agent execution

Agent definitions are host-owned configuration. Runtime instances receive independent context, state, tools, providers, permissions, and budgets while sharing the durable stores. Delegation depth, child tasks, concurrency, review loops, replans, cancellation, and task retries are bounded and observable.

## Security boundaries

Mnemos separates:

- trusted runtime code and host configuration;
- untrusted model output and generated PTC code;
- canonical data and rebuildable indexes;
- model-visible context and execution/audit history;
- tool authority and agent-provided arguments.

The default PTC backend is a **development subprocess**, not a hostile-tenant security boundary. It uses a fresh process, empty environment, temporary scratch directory, Node permission flags, source restrictions, wall-clock termination, quotas, and bounded IPC. Node alone cannot provide a complete OS-level network/memory isolation guarantee. The production container backend fails closed unless an explicitly configured image runner is available. Do not enable generated-code execution for mutually untrusted tenants without a separately reviewed Docker, gVisor, Firecracker, or equivalent deployment.

Authentication and authorization are deployment responsibilities; the demo console is intentionally unauthenticated.

## Development commands

Requirements: Node.js 22+ and pnpm 11+.

```bash
pnpm install

# build and type safety
pnpm build
pnpm typecheck

# tests
pnpm test
pnpm test:server
pnpm test:console
pnpm test:e2e

# deterministic, API-key-free evaluations
pnpm eval:retrieval
pnpm eval:ptc
pnpm eval:tools
pnpm eval:context
pnpm eval:memory
pnpm eval:reliability
pnpm eval:soak
pnpm eval:agents
pnpm eval:agents:soak

# operational helpers
pnpm mnemos doctor
pnpm mnemos migrate
pnpm mnemos rebuild-indexes
pnpm chat
```

All default tests and evaluations use mock/scripted providers, deterministic embeddings, synthetic workloads, simulated clocks, and fault injection. No paid model API key is required. Optional live-provider checks, if added by a host, must skip when credentials are unavailable.

`pnpm chat` uses `./mnemos.sqlite` by default. Set `MNEMOS_DB_PATH` and `MNEMOS_SESSION_ID` to choose the database and session.

## Repository map

```text
apps/server      Fastify API adapter and deterministic console runtime
apps/console     React/Vite web console
apps/cli         Interactive local chat shell
packages/core    Harness, context, memory, tools, PTC, agents and policies
packages/storage SQLite persistence, artifacts, jobs, indexes and audits
packages/contracts Shared Zod DTOs for server/console boundaries
docs/            Design and console documentation
```

Read [DESIGN.md](DESIGN.md) for the complete architecture, invariants, phase history, and extension points.

## License

Mnemos is released under the [MIT License](LICENSE).
