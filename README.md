# Mnemos

Mnemos is a TypeScript cognitive-harness runtime. Its architectural direction and staged roadmap are defined in [DESIGN.md](DESIGN.md).

## Current status

**Phase 1 — Runtime Foundation is implemented.** The project currently provides:

- `@mnemos/core`: `Harness`, the Visible Agent and replaceable `ModelProvider` interfaces, `MockModelProvider`, context accounting, bounded recent raw-context selection, pinned context, and an in-process event bus.
- `@mnemos/storage`: SQLite-backed append-only `HistoryStore` and separate mutable `StateStore` implementations.
- `@mnemos/cli`: an interactive, persistent chat shell using the mock provider.

The runtime emits `message.received`, `message.generated`, `context.pressure`, and `context.compaction.requested`. A compaction request is advisory in this phase: **no history is compacted or deleted**.

Not implemented yet: actual compaction, long-term memory, hidden-agent consolidation, retrieval/RAG, artifacts, tool runtime/discovery, and PTC. These remain intentionally reserved for Phases 2–9.

## Requirements

- Node.js 22+
- pnpm 11+

## Commands

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm chat
```

`pnpm chat` stores data in `./mnemos.sqlite` by default. Set `MNEMOS_DB_PATH` and `MNEMOS_SESSION_ID` to choose the database location and conversation session.

## Phase 2 extension points

`ContextManager` already exposes configurable token budgets, a tokenizer abstraction, bounded recent-message selection, pins, and `ContextStats`. `Harness` emits `context.compaction.requested` at high and emergency thresholds, while `HistoryStore` retains the complete raw history for a future compaction service to read without deleting it.
