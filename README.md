# Mnemos

Mnemos is a TypeScript cognitive-harness runtime. Its architectural direction and staged roadmap are defined in [DESIGN.md](DESIGN.md).

## Current status

**Phase 11 — Memory Intelligence is implemented.** The project currently provides:

- `@mnemos/core`: `Harness`, separate Visible and Hidden Agent abstractions over replaceable `ModelProvider` / `EmbeddingProvider` interfaces, Context Intelligence, Memory Intelligence, memory consolidation, hybrid retrieval / evaluation contracts, Artifact / spill contracts, and a provider-neutral Tool Runtime.
- `@mnemos/storage`: SQLite-backed append-only `HistoryStore`, separate mutable `StateStore`, durable compaction checkpoints, SQLite/FTS5 Memory with migrations, a durable consolidation-job queue, rebuildable vector and entity-graph projections, memory-intelligence audit records, and filesystem-backed Artifacts.
- `@mnemos/cli`: an interactive, persistent chat shell using the mock provider.

The runtime emits `message.received`, `message.generated`, `context.pressure`, `context.compaction.requested`, `context.evicted`, the `memory.consolidation.*` / `memory.*` lifecycle events, compact `tool.*` lifecycle events, compact `ptc.started` / `ptc.completed` / `ptc.failed` lifecycle events, and `tool.discovery.searched`, `tool.discovery.described`, `tool.loaded`, and `tool.unloaded` discovery events.

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
- `context.request_compaction`
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

## Dynamic Tool Discovery

Phase 9 adds a metadata index and a bounded, session-scoped loaded-tool set. Discovery is a normal part of the same runtime boundary:

```text
Visible Agent → ToolDispatcher → tools.search / tools.describe
             → ToolDiscoveryIndex → LoadedToolSet
             → native declarations or filtered PTC SDK → ToolDispatcher
```

`ToolRegistry` remains the canonical source of definitions. `ToolDiscoveryIndex` is a rebuildable lexical index derived from the Registry; registration, update, and removal notifications keep it current, while `toolSchemaHash` provides a stable short fingerprint for snapshots and audit metadata. Metadata such as namespace, summary, tags, capabilities, provider, version, visibility, permissions, side effects, and concurrency hints is authored on `ToolDefinition` and exported to both native and PTC surfaces—there is no second discovery contract.

`registerToolDiscoveryTools(registry, discovery)` registers the formal `tools.search` and `tools.describe` definitions. Both go through `ToolDispatcher`, require the host-granted `tools:read` permission, and return bounded structured results. Search is deterministic lexical ranking (exact name/namespace, token, tag, capability, and description signals) with namespace/capability/side-effect/provider filters. Describe returns complete JSON schemas only for selected, permission-available tools and loads them into the current session.

`ToolExposurePolicy` controls the core catalog, maximum dynamic tools, schema-token budget, result bytes, and describe batch size. Core tools are always preferred; dynamic schemas are loaded only after describe and are evicted deterministically by LRU when count or budget limits are reached. A request receives a stable declaration snapshot. A later Registry mutation affects later snapshots, while a stale or unloaded call is still rejected by `ToolDispatcher` with `tool_not_found`.

With `Harness.toolRuntime.discovery`, native mode exposes the core plus loaded dynamic schemas (and never the whole Registry). In `ptc` mode the model still sees `run_code` and discovery tools, while `PtcSdkGenerator` receives only the current host-selected catalog. `both` keeps both surfaces. Permission visibility is advisory in search (unavailable candidates are marked) and authoritative in `tools.describe`, the Dispatcher, and PTC RPC; generated arguments, forged identities, and raw RPC fields cannot grant access.

Discovery state is process-local and session-scoped. Search/describe outputs and discovery events contain bounded metadata and schema hashes, not large tool results. Full schemas count against Context through the existing schema accounting. Internal tool calls remain in audit/history as ordinary tool calls; they are not silently injected as extra model turns.

Phase 9 intentionally remains lexical and local. It does not add semantic embeddings, MCP, `tools.describe`-style dynamic external connectors, browser/shell access, or a production distributed sandbox. Those are later roadmap work (including the Phase 13 production PTC backend).

## Context Intelligence

Phase 10 adds runtime-owned context telemetry and deterministic policy decisions. `ContextStats` now reports physical availability separately from `safeHeadroomTokens` after the mandatory `generationReserveTokens`. It includes system, pinned, recent raw, retrieved-memory, tool-result, artifact-handle, and tool-schema accounting plus a stable pressure level: `NORMAL`, `ELEVATED`, `HIGH`, `COMPACTION`, or `EMERGENCY`.

`ContextPolicyEngine` applies configurable thresholds and session-scoped hysteresis. It emits typed recommendations such as `prefer_ptc`, `prefer_artifact`, `limit_memory_retrieval`, `avoid_loading_more_tools`, and `request_compaction`; recommendations do not grant the model ContextManager authority. At `EMERGENCY`, Harness preflight is enforced: it attempts safe compaction and refuses to invoke the provider unless `usedTokens + generationReserveTokens <= contextLimit`.

The cognitive context tools are bounded runtime capabilities:

- `context.inspect` returns only the current session's safe telemetry, pins, visible message IDs, and policy decision.
- `context.pin` creates a `visible-agent` pin with an independent budget, normalized-content dedupe, optional turn TTL, and restricted priority.
- `context.unpin` can remove only the caller's own agent pins; system and automatic-compaction pins are protected.
- `context.request_compaction` requests a safe runtime action; the agent cannot choose a cutoff or delete History.

Memory retrieval is packed against the policy's effective retrieval-token budget. Phase 9 dynamic schema sets can be reduced under pressure, while core tools remain available. Artifact handles and PTC final results continue to use the Phase 6/8 spill paths. Canonical History remains untouched, and semantic boundaries still protect tool transactions during compaction.

The current policy is deterministic and process-local. It does not implement adaptive learned routing, wall-clock pin expiry, semantic pin dedupe, or a separate Hidden Agent context policy; those remain future work.

## Memory Intelligence

Phase 11 adds a deterministic `MemoryIntelligenceService` between Hidden Agent proposals and `MemoryStore`. It keeps History canonical and treats every reinforcement, merge, abstraction, stale mark, decay score, and entity relationship as rebuildable derived state with source provenance.

- Reinforcement unions distinct `(sessionId, messageId)` evidence, is idempotent across retries, saturates confirmation/reinforcement scores, and evolves confidence with source-type caps. Repeated assistant inference cannot become an explicit fact by repetition.
- Effective retrieval signals combine similarity, confidence, importance, reinforcement, type/durability-aware time decay, stale status, and lifecycle status. Decay is recomputed from timestamps and policy; stale records remain queryable and are not deleted.
- Repeated episodic events can form a semantic abstraction only after configurable event-count, time-span, confidence, and evidence-diversity thresholds. Compatible records can merge into a provenance-preserving active record while originals remain archived with `mergedInto`; temporal replacement remains the separate `supersede` operation.
- A lightweight SQLite entity projection canonicalizes aliases such as `Postgres`/`PostgreSQL`, stores relationship provenance, emits entity lifecycle events, and can be cleared and rebuilt from Memory. Project/session scopes prevent cross-scope merges.
- `MemoryIntelligenceAuditStore` is replaceable; the default SQLite implementation records operation, memory IDs, source IDs, policy version, reason, and timestamp without storing raw model output.

The default maintenance path is explicit and deterministic (`runMaintenance()`); no daemon or API key is required. `MockModelProvider`/scripted proposals and deterministic embeddings are used at the external intelligence boundary, while MemoryStore, HistoryStore, retrieval, consolidation, source tracing, SQLite persistence, and runtime policy execute for real. Optional live-provider tests must be run explicitly and skip when credentials are unavailable.

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
pnpm eval:tools
pnpm eval:context
pnpm eval:memory
pnpm chat
```

`pnpm chat` stores data in `./mnemos.sqlite` by default. Set `MNEMOS_DB_PATH` and `MNEMOS_SESSION_ID` to choose the database location and conversation session. The CLI intentionally remains a minimal mock chat host; embedders enable the native tool loop by supplying `ToolRegistry`, `ToolDispatcher`, and host-granted permissions to `Harness`.

## Phase 12 extension points

The completed Phase 11 leaves stable boundaries for reliability work: `MemoryIntelligenceAuditStore`, `EntityGraphStore`, `MemoryDecayPolicy`, `MemoryIntelligenceService.runMaintenance()`, deterministic proposal schemas, and `MemoryVectorStore`/`EmbeddingProvider`/`MemoryReranker` replacement contracts. Phase 12 can add benchmark campaigns, recovery tests, and metrics without making Memory or the entity graph a source of truth. Dynamic discovery remains behind `ToolDiscoveryIndex.search`, `ToolDiscoveryRuntime.describe`, `LoadedToolSet`, and the existing `ToolDispatcher` permission gate.
