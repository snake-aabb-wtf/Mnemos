# Mnemos

Mnemos is a TypeScript cognitive-harness runtime. Its architectural direction and staged roadmap are defined in [DESIGN.md](DESIGN.md).

## Current status

**Phase 8 — Programmatic Tool Calling is implemented.** The project currently provides:

- `@mnemos/core`: `Harness`, separate Visible and Hidden Agent abstractions over replaceable `ModelProvider` / `EmbeddingProvider` interfaces, context accounting, memory consolidation, hybrid retrieval / evaluation contracts, Artifact / spill contracts, and a provider-neutral Tool Runtime.
- `@mnemos/storage`: SQLite-backed append-only `HistoryStore`, separate mutable `StateStore`, durable compaction checkpoints, SQLite/FTS5 Memory, a durable consolidation-job queue, a rebuildable local vector index, and SQLite metadata plus filesystem-backed Artifacts.
- `@mnemos/cli`: an interactive, persistent chat shell using the mock provider.

The runtime emits `message.received`, `message.generated`, `context.pressure`, `context.compaction.requested`, `context.evicted`, the `memory.consolidation.*` / `memory.*` lifecycle events, compact `tool.*` lifecycle events, and compact `ptc.started` / `ptc.completed` / `ptc.failed` lifecycle events.

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

## Artifact Store

Phase 6 keeps large, intermediate data out of visible-agent Context. `ArtifactStore` is a Core contract with `create`, `get`, `read`, `query`, `delete`, `verify`, expiry cleanup, and orphan recovery operations. `SqliteArtifactStore` is the default implementation:

```text
Artifact metadata + derived text-line index → SQLite
Immutable Artifact body                    → configured local filesystem directory
Visible-agent context                      → small artifact:// handle only
```

An `ArtifactRecord` contains scope (`session` or `persistent`), optional expiry, MIME/type, byte size, SHA-256 checksum, summary, and opaque internal storage location. Its public `ArtifactHandle` deliberately excludes the storage location and body. `ContextManager.buildVisible(..., artifactHandles)` accounts only for handle text, never body bytes.

Bodies use generated UUID filenames rather than display names, remain confined to the configured storage directory, are written to a temporary file and atomically renamed before metadata is published, and are checksum-verified on full reads or with `verify`. Metadata reads do not touch body files. Range reads use filesystem offsets; text query runs locally against a bounded, rebuildable line/chunk index and rejects binary MIME types. A missing body remains visible in metadata and raises a specific error on body operations so it can be diagnosed or cleaned up safely.

`ArtifactSpillService` is used by the Phase 7 dispatcher: small strings may remain inline; binary values and larger strings or streams are stored and returned as an `artifact://…` handle. It consumes `string`, `Uint8Array`, or `AsyncIterable<Uint8Array>` without converting a stream into a giant context string.

## Tool Runtime

Phase 7 adds the formal execution path for all current and future tools:

```text
Model ToolCall → ToolRegistry → permission check → Zod validation
→ timeout-aware execution → output normalization / Artifact spill
→ audit + tool lifecycle event → structured ToolResult
```

`ToolDefinition` provides a stable dotted name (plus reserved runtime entry point `run_code`), description, Zod input/output schemas, explicit execution context, required permissions, side-effect classification (`none`, `read`, `write`, `destructive`), concurrency hint, and optional timeout. `ToolRegistry` only owns registration and discovery of definitions; `ToolDispatcher` is the sole execution gate for native calls and PTC subcalls.

Dispatcher results are either a bounded inline value or an Artifact handle. Invalid arguments, missing tools, denied permissions, timeouts, invalid output, spill failures, and execution exceptions return structured, model-safe error envelopes; internal exception text and stacks are never returned to the model. The output policy has independent inline, spill, and model-visible byte limits. Binary output is always externalized.

The initial cognitive tool set is:

- `memory.search`, `memory.get`, `memory.source`, `memory.timeline`, `memory.remember`
- `history.search`, `history.get`
- `context.inspect`, `context.pin`, `context.unpin`
- `state.get`, `state.set`, `state.patch`
- `artifact.get`, `artifact.read`, `artifact.query`, `artifact.create`, `artifact.delete`

`memory.remember` calls the existing consolidation-job path only; it cannot mutate canonical Memory. `artifact.read` is range-limited for model calls, and oversized text or any binary result is spilled by the dispatcher. `history.search` is deliberately a bounded basic lexical scan at this stage, not a second RAG implementation.

Permissions are host-provided in `ToolDispatchContext` (`sessionId`, `agentId`, `principal`, granted `domain:verb` permissions) and cannot be elevated by model arguments. `ToolAuditStore` is a replaceable audit boundary; `InMemoryToolAuditStore` records principal, tool, call ID, timing, success/denial/failure, and spill status. Events (`tool.called`, `tool.completed`, `tool.failed`, `tool.denied`, `tool.output.spilled`) contain identifiers, timing, status, and handles only—not raw arguments or large outputs.

Zod remains the single authored schema. The registry exports a deterministic JSON Schema subset for provider-neutral `ModelToolDeclaration`s; no vendor SDK types enter Core. `ModelProvider` can now return normal text or a native tool-call response. When `Harness` receives a tool-call response, it records an assistant tool-call message and paired tool result in append-only History, dispatches through the sole runtime entry point, rebuilds Context, and asks the model to continue. `maxToolIterations` terminates loops safely. Tool declaration, tool-call, and tool-result tokens are all included in Context accounting; spilled results record only their small handles in History.

## Programmatic Tool Calling

Phase 8 introduces run_code as an ordinary registered Tool:

    Visible Agent -> run_code -> PtcRuntime -> isolated child process
    -> generated tools.* SDK / IPC -> PtcToolScheduler -> ToolDispatcher -> actual Tool

PtcSdkGenerator derives TypeScript declarations and the catalog from existing ToolRegistry JSON Schema descriptors. There is no second PTC-only tool contract. The sandbox receives no stores, Dispatcher, filesystem path, database object, environment, or actual tool implementation. A tools.memory.search(input) call is an RPC request whose host side reconstructs identity and permissions from the original execution context before calling ToolDispatcher.

ToolExecutionMode is configurable per Harness: native exposes normal tools except run_code; ptc exposes only run_code; both exposes both. When PTC is enabled, Harness passes versioned ptc-policy/v1 instructions and the generated SDK catalog as ModelRequest.runtimeInstructions, and accounts for them alongside visible tool schemas. The default remains native for a Phase 7-only Registry; a Registry with a registered PtcRuntime defaults to both.

Each invocation gets a fresh Node child process, an empty environment, a private temporary working directory, Node Permission Model deny-by-default filesystem/child-process/worker/addon/WASI capabilities, bounded IPC, a V8 old-space limit, a parent-enforced wall-clock deadline, and cleanup after termination. TypeScript is stripped/transformed host-side; imports, require, process, direct network APIs, and other ambient-capability spellings are rejected before launch. The program can only use tools.*; no code parameter can add a permission.

This is an isolated development backend, not a claim of production-grade hostile-code confinement. Node's Permission Model has no general OS-level network-deny switch, and language-level source rejection is defense in depth rather than a complete adversarial-JavaScript proof. Phase 13 should supply the same PtcSandbox interface with a container, gVisor, Firecracker, or equivalent network-isolated backend. Do not enable generated-code execution for mutually untrusted tenants on this backend.

The memory setting is a V8 old-space ceiling for the child process, so Node/runtime minimums and external/native allocations can make it less precise than a cgroup/container memory limit. The parent still isolates a crash from Mnemos and converts obvious heap exhaustion into a structured PTC error; production hardening needs an OS-level memory controller.

PtcToolScheduler consults the existing Tool metadata. concurrencySafe none/read calls can overlap up to maxConcurrentToolCalls; writes, destructive tools, and non-concurrency-safe calls wait for preceding reads and form a barrier for following work. PTC enforces maxToolCalls, maxExecutionMs, maxMemoryMb, maxToolArgumentBytes, bounded logs, and separate inline/transport result byte limits. Inner Dispatcher results already follow Artifact spill; a large final PTC result is force-spilled as a ptc-result Artifact handle. Only the single run_code request/result pair enters conversational History and visible Context; all inner calls remain in dispatcher audit/events.

Register it explicitly in a host composition root:

    const ptc = new PtcRuntime({ registry, dispatcher, artifactSpill, events });
    registerPtcTool(registry, ptc);
    const harness = new Harness({
      history, state, provider,
      toolRuntime: {
        registry, dispatcher, ptc, executionMode: "both",
        grantedPermissions: ["tool:execute", "memory:read", "history:read"],
      },
    });

Not implemented yet: dynamic tool discovery, semantic tool search, MCP/external connectors, browser or shell host access, a production sandbox fleet, memory decay, entity-graph reasoning, and distributed retrieval. These remain intentionally reserved for Phases 9 and later.

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
pnpm eval:ptc
pnpm chat
```

`pnpm chat` stores data in `./mnemos.sqlite` by default. Set `MNEMOS_DB_PATH` and `MNEMOS_SESSION_ID` to choose the database location and conversation session. The CLI intentionally remains a minimal mock chat host; embedders enable the native tool loop by supplying `ToolRegistry`, `ToolDispatcher`, and host-granted permissions to `Harness`.

## Phase 9 extension points

Phase 9 must build Dynamic Tool Discovery on existing Registry descriptors and PtcSdkGenerator, without creating a second contract or exposing raw implementations. PtcSandbox, PtcRuntime, ToolExecutionMode, versioned PTC policy instructions, and Context schema accounting are the Phase 8 boundaries available to the next phase. MemoryVectorStore, EmbeddingProvider, and MemoryReranker remain independently replaceable for future sqlite-vec, external model, cross-encoder, or larger-scale adapters.
