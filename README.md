# Mnemos

Mnemos is a TypeScript cognitive-harness runtime. Its architectural direction and staged roadmap are defined in [DESIGN.md](DESIGN.md).

## Current status

**Phase 5 — Hybrid Memory Retrieval is implemented.** The project currently provides:

- `@mnemos/core`: `Harness`, separate Visible and Hidden Agent abstractions over replaceable `ModelProvider` / `EmbeddingProvider` interfaces, context accounting, memory consolidation, and hybrid retrieval / evaluation contracts.
- `@mnemos/storage`: SQLite-backed append-only `HistoryStore`, separate mutable `StateStore`, durable compaction checkpoints, SQLite/FTS5 Memory, a durable consolidation-job queue, and a rebuildable local vector index.
- `@mnemos/cli`: an interactive, persistent chat shell using the mock provider.

The runtime emits `message.received`, `message.generated`, `context.pressure`, `context.compaction.requested`, `context.evicted`, and the `memory.consolidation.*` / `memory.*` lifecycle events.

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

## Hidden-agent consolidation

`MemoryConsolidationService` is a background pipeline, separate from `Harness` and `ContextManager`:

```text
context.evicted → durable job → extract candidates → lexical retrieve
→ reconcile proposal → runtime validation → MemoryService / MemoryStore
```

`HiddenAgent` has no `MemoryStore` capability. It returns only untrusted structured JSON, which is parsed with Zod before the runtime applies `new`, `duplicate`, `update`, `supersede`, or `irrelevant` operations. A `contradiction` is accepted only as an explicit intermediate judgment: the job fails retryably until it is reconciled into an update or supersession, so conflicting current facts are never silently persisted. The policy lives in a versioned module; `ModelProviderHiddenAgent` defaults to a separate 1M-token context budget without binding Core to a vendor SDK.

Every proposal source must reference a real message from that job's evicted set in the same session. `MemoryService` then revalidates canonical History before each write. `assistant_inference` is capped at 0.5 confidence; it cannot silently become an explicit user fact.

`SqliteConsolidationJobStore` records `pending`, `running`, `completed`, and `failed` jobs. A SHA-256 key over the exact evicted message IDs deduplicates repeated event delivery. Writes use deterministic job-derived IDs, so post-crash retries converge instead of producing duplicate Memory. Interrupted `running` jobs are requeued when a new worker begins processing; failed jobs require an explicit `retry(jobId)`.

Attach the service to the event bus, then run its worker separately from visible requests:

```ts
const stop = consolidation.attach(harness.events);
await consolidation.processAvailable(); // invoke from a background worker loop
stop();
```

`consolidation.remember({ sessionId, candidate })` is the safe `memory.remember()` domain entry point for a Visible Agent. It first checks that the candidate's source messages exist in canonical History, then persists a `visible-candidate` consolidation job. The candidate is merely a hint to the Hidden Agent; it cannot write Memory directly.

Memory lifecycle events are emitted only around completed state transitions. Subscriber exceptions are caught by the consolidation service and cannot roll back or partially complete a Memory transaction.

## Hybrid Memory Retrieval

`MemoryRetriever` is now the single upper-layer API. It accepts a query plus optional type, status, source-type, entity, tag, confidence, time-range, and source-session filters, and returns explainable `MemoryRetrievalResult` entries:

```text
query normalization
  ├─ FTS5 lexical candidates
  ├─ local vector semantic candidates
  └─ entity candidates
        ↓
metadata filtering → reciprocal-rank fusion → deterministic reranker → Top K
```

`HybridMemoryRetriever` deliberately fuses ranks with Reciprocal Rank Fusion rather than adding incompatible FTS5 BM25 and cosine-similarity scales. Results expose lexical, semantic, entity, recency, confidence, and status signals together with `matchedBy` reasons. Current-fact queries default to `active`; callers must explicitly request `superseded` records for historical queries.

`EmbeddingProvider` is independent of `ModelProvider`. `DeterministicEmbeddingProvider` is supplied for offline tests; production hosts can supply OpenAI, Gemini, Voyage, Jina, local, or OpenAI-compatible adapters without changing Core.

`MemoryEmbeddingIndexer` is attached to `MemoryService` as a derived-index lifecycle hook. Creation and content updates embed; metadata-only updates reuse the prior vector; supersession refreshes index metadata for both records. Every vector record stores model/version, dimensions, content hash, and retrieval metadata. `indexer.rebuild()` replaces the index from canonical Memory, so the index is never a source of truth.

Hosts construct `HybridMemoryRetriever` with their `EmbeddingProvider` and `MemoryVectorStore`, then inject it into `MemoryConsolidationService`. Consolidation itself is unchanged: it receives ranked records through `MemoryRetriever` and continues to own only proposal validation and canonical Memory transitions.

The current local backend is `SqliteMemoryVectorStore`. `sqlite-vec` is not installed as a compatible `better-sqlite3` extension in this workspace, so Phase 5 uses a reliable SQLite metadata table with persisted normalized vectors and Top-K vector-ID retrieval. It scans derived vectors—not canonical Memory rows—and hydrates only fused candidates. A future sqlite-vec adapter can implement the same `MemoryVectorStore` contract.

Phase 4 consolidation accepts this same retriever unchanged. The fixed Phase 5 evaluation fixture covers exact lexical match, semantic paraphrase, symbols, entity retrieval, current vs historical facts, and confidence; its deterministic tests compute Recall@K, Hit@K, and MRR.

Not implemented yet: Artifact Store, tool runtime/discovery, PTC, memory decay, entity-graph reasoning, and distributed retrieval. These remain intentionally reserved for Phases 6–9.

## Requirements

- Node.js 22+
- pnpm 11+

## Commands

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm eval:retrieval
pnpm chat
```

`pnpm chat` stores data in `./mnemos.sqlite` by default. Set `MNEMOS_DB_PATH` and `MNEMOS_SESSION_ID` to choose the database location and conversation session.

## Phase 6 extension points

Phase 6 can add Artifact storage without changing retrieval or consolidation boundaries. `MemoryVectorStore`, `EmbeddingProvider`, and `MemoryReranker` remain independently replaceable for future sqlite-vec, external model, cross-encoder, or larger-scale adapters.
