# Mnemos

Mnemos is a TypeScript cognitive-harness runtime. Its architectural direction and staged roadmap are defined in [DESIGN.md](DESIGN.md).

## Current status

**Phase 2 — Context Compaction is implemented.** The project currently provides:

- `@mnemos/core`: `Harness`, the Visible Agent and replaceable `ModelProvider` interfaces, `MockModelProvider`, context accounting, session-aware pinned context, an in-process event bus, and a `CompactionService`.
- `@mnemos/storage`: SQLite-backed append-only `HistoryStore`, separate mutable `StateStore`, and durable compaction checkpoints.
- `@mnemos/cli`: an interactive, persistent chat shell using the mock provider.

The runtime emits `message.received`, `message.generated`, `context.pressure`, `context.compaction.requested`, and `context.evicted`.

## Context compaction

`CompactionService` treats History as canonical and immutable. When the visible working context exceeds the configured recent-raw budget or reaches high pressure, it:

1. Reads canonical history after the durable session checkpoint.
2. Selects a cutoff close to the target, preferring task, complete user/assistant turn, tool-transaction, and finally message boundaries.
3. Retains the bounded recent raw tail, creates or replaces one session-scoped automatic pinned context, and persists the checkpoint.
4. Emits `context.evicted` only after that pin and checkpoint have been updated.

The event includes every evicted message and ID, an inclusive source range, the selected cutoff, the next retained message ID, and the new automatic pin. A future Hidden Agent can consume the event directly or re-read the canonical records; compaction never deletes them.

For tool-aware boundaries, annotate related History messages with the same string `metadata.transactionId`. Optional `metadata.taskId` marks task transitions for higher-priority cutoff selection.

The default pin generator is deterministic and bounded, so correctness does not depend on an LLM summary. A custom `CompactionSummarizer` may be supplied when richer summaries are wanted.

Not implemented yet: long-term memory, hidden-agent consolidation, retrieval/RAG, embeddings, artifacts, tool runtime/discovery, and PTC. These remain intentionally reserved for Phases 3–9.

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

## Phase 3 extension points

`context.evicted` carries the exact evicted messages, IDs, and canonical source range that a Hidden Agent can consolidate into Memory. `CompactionSummarizer` is replaceable, while `ContextCompactionStore` keeps compaction checkpoints independent from `HistoryStore` and agent working state. Phase 3 can add a separate `MemoryStore` without changing these boundaries.
