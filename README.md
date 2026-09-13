# Mnemos

Mnemos is a TypeScript cognitive-harness runtime. Its architectural direction and staged roadmap are defined in [DESIGN.md](DESIGN.md).

## Current status

**Phase 3 — Long-Term Memory Foundation is implemented.** The project currently provides:

- `@mnemos/core`: `Harness`, the Visible Agent and replaceable `ModelProvider` interfaces, `MockModelProvider`, context accounting, session-aware pinned context, an in-process event bus, `CompactionService`, and Memory-domain contracts/services.
- `@mnemos/storage`: SQLite-backed append-only `HistoryStore`, separate mutable `StateStore`, durable compaction checkpoints, and a SQLite/FTS5 `MemoryStore`.
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

## Long-term Memory

`MemoryRecord` is a derived, fallible record. It never alters canonical History and always includes ordered `sourceReferences` (`sessionId` + stable History message ID) as well as the corresponding `sourceIds`.

The Phase 3 model supports semantic, episodic, decision, preference, and entity records; confidence, importance, source type, confirmation time, status, entities, tags, and a durable supersede relation.

`MemoryStore` is a Core abstraction. `SqliteMemoryStore` uses normalized source/entity/tag tables and SQLite FTS5 lexical search. Search defaults to active records, so superseded records are not surfaced as current facts unless callers explicitly include `statuses: ["superseded"]`.

`MemoryService` provides the domain-level `get`, `search`, `source`, and `timeline` APIs. `source` resolves every reference through `HistoryStore` and fails clearly if canonical evidence is absent. `timeline` returns records ordered by creation time for an entity or tag, including explicit superseded-history queries.

Superseding is an atomic store operation: it preserves the old record, changes it to `superseded`, and sets its successor. Self-supersession, missing successors, archived predecessors, and invalid successor statuses are rejected.

Memory creation remains explicit in this phase. Mnemos does **not** yet subscribe to `context.evicted`, extract facts with an LLM, or automatically create Memory.

Not implemented yet: Hidden Agent consolidation, embeddings/vector retrieval, reranking, artifacts, tool runtime/discovery, and PTC. These remain intentionally reserved for Phases 4–9.

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

## Phase 4 extension points

`context.evicted` already carries exact History references and raw evicted messages. A future Hidden Agent can use `MemoryService.create` with those references after it performs extraction, comparison, and reconciliation. Memory storage itself has no event subscription and no model dependency, preserving the Phase 4 boundary.
