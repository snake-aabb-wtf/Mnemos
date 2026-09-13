import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ContextEviction } from "./compaction.js";
import { CharacterTokenEstimator, type BuiltContext } from "./context.js";
import type { HistoryMessage, HistoryStore } from "./contracts.js";
import type { EventBus, HarnessEventMap } from "./events.js";
import { HIDDEN_AGENT_CONSOLIDATION_POLICY, HIDDEN_AGENT_CONSOLIDATION_POLICY_VERSION } from "./hidden-agent-policy.js";
import {
  memoryIdSchema,
  memorySourceReferenceSchema,
  memorySourceTypeSchema,
  memoryTypeSchema,
  type MemoryRecord,
  type MemoryService,
  type MemorySourceReference,
} from "./memory.js";
import type { ModelProvider } from "./model.js";
import type { MemoryRetriever } from "./retrieval.js";

const textSchema = z.string().trim().min(1);
const isoDateSchema = z.string().datetime();
const sourceRangeSchema = z.object({
  firstMessageId: memoryIdSchema,
  lastMessageId: memoryIdSchema,
  messageCount: z.number().int().positive(),
}).strict();

export const hiddenMemoryCandidateSchema = z.object({
  content: textSchema,
  type: memoryTypeSchema,
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  sourceType: memorySourceTypeSchema,
  sourceReferences: z.array(memorySourceReferenceSchema).min(1).refine(
    (sources) => new Set(sources.map((source) => `${source.sessionId}:${source.messageId}`)).size === sources.length,
    "sourceReferences cannot contain duplicates",
  ),
  entities: z.array(textSchema).default([]),
  tags: z.array(textSchema).default([]),
  /** Optional bounded lexical query. Phase 5 can replace the retriever without changing the agent. */
  retrievalQuery: textSchema.optional(),
  status: z.enum(["active", "provisional"]).default("provisional"),
}).strict();
export type HiddenMemoryCandidate = z.infer<typeof hiddenMemoryCandidateSchema>;

/** A Visible Agent may suggest this input, but it never authorizes a direct Memory write. */
export const memoryRememberRequestSchema = z.object({
  sessionId: textSchema,
  candidate: hiddenMemoryCandidateSchema,
}).strict().superRefine((request, context) => {
  for (const source of request.candidate.sourceReferences) {
    if (source.sessionId !== request.sessionId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "memory.remember sources must use the submitted session" });
    }
  }
});
export type MemoryRememberRequest = z.infer<typeof memoryRememberRequestSchema>;

const memoryPatchSchema = z.object({
  type: memoryTypeSchema.optional(),
  content: textSchema.optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceType: memorySourceTypeSchema.optional(),
  status: z.enum(["active", "provisional", "archived"]).optional(),
  entities: z.array(textSchema).optional(),
  tags: z.array(textSchema).optional(),
}).strict();
export type ConsolidationMemoryPatch = z.infer<typeof memoryPatchSchema>;

const newDecisionSchema = z.object({ kind: z.literal("new"), candidate: hiddenMemoryCandidateSchema }).strict();
const duplicateDecisionSchema = z.object({
  kind: z.literal("duplicate"),
  existingMemoryId: memoryIdSchema,
  sourceReferences: z.array(memorySourceReferenceSchema).min(1),
}).strict();
const updateDecisionSchema = z.object({
  kind: z.literal("update"),
  existingMemoryId: memoryIdSchema,
  patch: memoryPatchSchema,
  sourceReferences: z.array(memorySourceReferenceSchema).min(1),
}).strict();
const supersedeDecisionSchema = z.object({
  kind: z.literal("supersede"),
  existingMemoryId: memoryIdSchema,
  replacement: hiddenMemoryCandidateSchema,
}).strict();
/**
 * A contradiction is intentionally not a write operation. The runtime records
 * it as retryable job failure until an agent turns it into an update or a
 * supersession, preventing two conflicting current facts from being accepted.
 */
const contradictionDecisionSchema = z.object({
  kind: z.literal("contradiction"),
  existingMemoryId: memoryIdSchema,
  sourceReferences: z.array(memorySourceReferenceSchema).min(1),
  reason: textSchema.optional(),
}).strict();
const irrelevantDecisionSchema = z.object({ kind: z.literal("irrelevant"), reason: textSchema.optional() }).strict();

export const consolidationDecisionSchema = z.discriminatedUnion("kind", [
  newDecisionSchema,
  duplicateDecisionSchema,
  updateDecisionSchema,
  supersedeDecisionSchema,
  contradictionDecisionSchema,
  irrelevantDecisionSchema,
]);
export type ConsolidationDecision = z.infer<typeof consolidationDecisionSchema>;

export const consolidationExtractionSchema = z.object({
  candidates: z.array(hiddenMemoryCandidateSchema),
}).strict();
export type ConsolidationExtraction = z.infer<typeof consolidationExtractionSchema>;

export const consolidationProposalSchema = z.object({
  decisions: z.array(consolidationDecisionSchema),
}).strict();
export type ConsolidationProposal = z.infer<typeof consolidationProposalSchema>;

export const consolidationJobStatusSchema = z.enum(["pending", "running", "completed", "failed"]);
export type ConsolidationJobStatus = z.infer<typeof consolidationJobStatusSchema>;

export const consolidationJobSchema = z.object({
  id: memoryIdSchema,
  /** SHA-256 of the exact evicted message set; duplicate delivery is a no-op. */
  deduplicationKey: z.string().regex(/^[a-f0-9]{64}$/),
  origin: z.enum(["eviction", "visible-candidate"]),
  sessionId: textSchema,
  sourceRange: sourceRangeSchema,
  evictedMessageIds: z.array(memoryIdSchema).min(1).refine(
    (ids) => new Set(ids).size === ids.length,
    "evictedMessageIds cannot contain duplicates",
  ),
  /** Optional suggestions from memory.remember; the Hidden Agent still decides what to do. */
  candidateHints: z.array(hiddenMemoryCandidateSchema).default([]),
  status: consolidationJobStatusSchema,
  attempts: z.number().int().nonnegative(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  lastError: textSchema.optional(),
}).strict();
export type ConsolidationJob = z.infer<typeof consolidationJobSchema>;

export interface EnqueueConsolidationJobResult {
  job: ConsolidationJob;
  created: boolean;
}

/** Durable queue boundary. Storage owns atomic claiming and persistence. */
export interface ConsolidationJobStore {
  enqueue(eviction: ContextEviction): Promise<EnqueueConsolidationJobResult>;
  enqueueVisibleCandidate(request: MemoryRememberRequest): Promise<EnqueueConsolidationJobResult>;
  get(id: string): Promise<ConsolidationJob | undefined>;
  claimNext(): Promise<ConsolidationJob | undefined>;
  complete(id: string): Promise<ConsolidationJob>;
  fail(id: string, error: string): Promise<ConsolidationJob>;
  retry(id: string): Promise<ConsolidationJob>;
  /** Requeues work left running by a prior process before a worker starts. */
  recoverRunning(): Promise<number>;
  list(statuses?: readonly ConsolidationJobStatus[]): Promise<ConsolidationJob[]>;
}

export function consolidationDeduplicationKey(eviction: Pick<ContextEviction, "sessionId" | "evictedMessageIds">): string {
  return createHash("sha256")
    .update(JSON.stringify({ origin: "eviction", sessionId: eviction.sessionId, evictedMessageIds: eviction.evictedMessageIds }))
    .digest("hex");
}

export function newConsolidationJob(eviction: ContextEviction, now = new Date().toISOString()): ConsolidationJob {
  return consolidationJobSchema.parse({
    id: randomUUID(),
    deduplicationKey: consolidationDeduplicationKey(eviction),
    origin: "eviction",
    sessionId: eviction.sessionId,
    sourceRange: eviction.sourceRange,
    evictedMessageIds: eviction.evictedMessageIds,
    candidateHints: [],
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  });
}

export function newVisibleCandidateConsolidationJob(request: MemoryRememberRequest, now = new Date().toISOString()): ConsolidationJob {
  const parsed = memoryRememberRequestSchema.parse(request);
  const evictedMessageIds = parsed.candidate.sourceReferences.map((source) => source.messageId);
  const deduplicationKey = createHash("sha256").update(JSON.stringify({
    origin: "visible-candidate",
    sessionId: parsed.sessionId,
    evictedMessageIds,
    candidate: parsed.candidate,
  })).digest("hex");
  return consolidationJobSchema.parse({
    id: randomUUID(),
    deduplicationKey,
    origin: "visible-candidate",
    sessionId: parsed.sessionId,
    sourceRange: {
      firstMessageId: evictedMessageIds[0],
      lastMessageId: evictedMessageIds.at(-1)!,
      messageCount: evictedMessageIds.length,
    },
    evictedMessageIds,
    candidateHints: [parsed.candidate],
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  });
}

export interface HiddenAgentConfig {
  /** A separate background budget; its default is intentionally larger than visible context. */
  contextLimit: number;
  /** Provider-neutral model selector retained for the host application's provider adapter. */
  model?: string;
}

export const defaultHiddenAgentConfig: HiddenAgentConfig = { contextLimit: 1_000_000 };

export interface HiddenExtractionRequest {
  job: ConsolidationJob;
  evictedMessages: readonly HistoryMessage[];
  policyVersion: string;
}

export interface HiddenReconciliationInput {
  candidate: HiddenMemoryCandidate;
  relatedMemories: readonly MemoryRecord[];
}

export interface HiddenReconciliationRequest extends HiddenExtractionRequest {
  candidates: readonly HiddenReconciliationInput[];
}

/**
 * The hidden agent has no MemoryStore capability. It can only return untrusted
 * structured data, which the runtime parses and applies later.
 */
export interface HiddenAgent {
  extract(request: HiddenExtractionRequest): Promise<unknown>;
  reconcile(request: HiddenReconciliationRequest): Promise<unknown>;
}

/** Provider-neutral hidden-agent adapter. A real provider is responsible only for JSON generation. */
export class ModelProviderHiddenAgent implements HiddenAgent {
  readonly config: HiddenAgentConfig;

  constructor(private readonly provider: ModelProvider, config: Partial<HiddenAgentConfig> = {}) {
    this.config = { ...defaultHiddenAgentConfig, ...config };
  }

  async extract(request: HiddenExtractionRequest): Promise<unknown> {
    return this.invoke("extract", request, request.evictedMessages);
  }

  async reconcile(request: HiddenReconciliationRequest): Promise<unknown> {
    return this.invoke("reconcile", request, request.evictedMessages);
  }

  private async invoke(stage: "extract" | "reconcile", request: HiddenExtractionRequest | HiddenReconciliationRequest, messages: readonly HistoryMessage[]): Promise<unknown> {
    const context = this.buildContext(messages);
    const response = await this.provider.generate({
      sessionId: request.job.sessionId,
      context,
      input: JSON.stringify({
        policyVersion: HIDDEN_AGENT_CONSOLIDATION_POLICY_VERSION,
        policy: HIDDEN_AGENT_CONSOLIDATION_POLICY,
        hiddenModel: this.config.model,
        stage,
        request,
        responseSchema: stage === "extract" ? "{ candidates: HiddenMemoryCandidate[] }" : "{ decisions: ConsolidationDecision[] }",
      }),
    });
    if (response.kind === "tool-calls") throw new Error(`Hidden Agent cannot request tools during ${stage}`);
    try {
      return JSON.parse(response.content) as unknown;
    } catch {
      throw new Error(`Hidden Agent returned invalid JSON during ${stage}`);
    }
  }

  private buildContext(messages: readonly HistoryMessage[]): BuiltContext {
    const estimator = new CharacterTokenEstimator();
    const usedTokens = messages.reduce((total, message) => total + estimator.estimateMessage(message), 0);
    if (usedTokens > this.config.contextLimit) {
      throw new Error(`Hidden Agent input exceeds configured context limit of ${this.config.contextLimit} tokens`);
    }
    return {
      pinned: [],
      recentMessages: messages,
      artifactHandles: [],
      toolSchemas: [],
      stats: {
        usedTokens,
        contextLimit: this.config.contextLimit,
        systemTokens: 0,
        pinnedTokens: 0,
        recentRawTokens: usedTokens,
        artifactHandleTokens: 0,
        toolSchemaTokens: 0,
        retrievedMemoryTokens: 0,
        toolResultTokens: 0,
        reservedTokens: 0,
        pressure: usedTokens / this.config.contextLimit,
      },
    };
  }
}

export type ConsolidationOperation =
  | { kind: "new"; record: MemoryRecord; applied: boolean }
  | { kind: "duplicate"; record: MemoryRecord }
  | { kind: "update"; record: MemoryRecord }
  | { kind: "supersede"; superseded: MemoryRecord; replacement: MemoryRecord; applied: boolean }
  | { kind: "irrelevant"; reason?: string };

export interface ConsolidationResult {
  job: ConsolidationJob;
  extraction: ConsolidationExtraction;
  proposal: ConsolidationProposal;
  operations: readonly ConsolidationOperation[];
}

export interface MemoryConsolidationServiceOptions {
  history: HistoryStore;
  memories: MemoryService;
  jobs: ConsolidationJobStore;
  hiddenAgent: HiddenAgent;
  /** Required composition dependency; Phase 5 hosts provide HybridMemoryRetriever here. */
  retriever: MemoryRetriever;
  events?: EventBus<HarnessEventMap>;
  onBackgroundError?: (error: Error) => void;
}

/**
 * Background-only Phase 4 pipeline. Hosts enqueue from context.evicted and
 * explicitly pump processNext/processAvailable from a worker loop.
 */
export class MemoryConsolidationService {
  private readonly retriever: MemoryRetriever;
  private recovered = false;

  constructor(private readonly options: MemoryConsolidationServiceOptions) {
    this.retriever = options.retriever;
  }

  /** Subscribes only to durable job creation; no model work runs on the visible lifecycle. */
  attach(events: EventBus<HarnessEventMap>): () => void {
    return events.on("context.evicted", async (eviction) => {
      try {
        const queued = await this.options.jobs.enqueue(eviction);
        await this.publish("memory.consolidation.requested", queued);
      } catch (error) {
        this.report(error);
      }
    });
  }

  /**
   * Safe Phase 4 entry point for a Visible Agent's `memory.remember()` tool.
   * It persists only a candidate job; Hidden Agent reconciliation remains the
   * sole path to canonical Memory mutation.
   */
  async remember(request: MemoryRememberRequest): Promise<EnqueueConsolidationJobResult> {
    const parsed = memoryRememberRequestSchema.parse(request);
    for (const source of parsed.candidate.sourceReferences) {
      if (!await this.options.history.get(source.sessionId, source.messageId)) {
        throw new Error(`memory.remember source is missing from canonical History: ${source.messageId}`);
      }
    }
    const queued = await this.options.jobs.enqueueVisibleCandidate(parsed);
    await this.publish("memory.consolidation.requested", queued);
    return queued;
  }

  async processNext(): Promise<ConsolidationResult | undefined> {
    if (!this.recovered) {
      await this.options.jobs.recoverRunning();
      this.recovered = true;
    }
    const job = await this.options.jobs.claimNext();
    return job === undefined ? undefined : this.processClaimed(job);
  }

  async processAvailable(limit = Number.POSITIVE_INFINITY): Promise<readonly ConsolidationResult[]> {
    const results: ConsolidationResult[] = [];
    while (results.length < limit) {
      try {
        const result = await this.processNext();
        if (!result) break;
        results.push(result);
      } catch (error) {
        // A failed job is already durable and retryable. Keep processing later jobs.
        this.report(error);
      }
    }
    return results;
  }

  private async processClaimed(job: ConsolidationJob): Promise<ConsolidationResult> {
    await this.publish("memory.consolidation.started", { job });
    try {
      const evictedMessages = await this.loadEvictedMessages(job);
      const request: HiddenExtractionRequest = { job, evictedMessages, policyVersion: HIDDEN_AGENT_CONSOLIDATION_POLICY_VERSION };
      const extraction = consolidationExtractionSchema.parse(await this.options.hiddenAgent.extract(request));
      this.assertCandidateGrounding(extraction.candidates, job);
      const candidates = await Promise.all(extraction.candidates.map(async (candidate) => ({
        candidate,
        relatedMemories: (await this.retriever.retrieve({
          query: candidate.retrievalQuery ?? candidate.entities[0] ?? candidate.content,
          limit: 10,
        })).map((result) => result.memory),
      })));
      const proposal = consolidationProposalSchema.parse(await this.options.hiddenAgent.reconcile({ ...request, candidates }));
      this.assertProposalGrounding(proposal, job);
      const operations = await this.applyProposal(job, proposal);
      const completed = await this.options.jobs.complete(job.id);
      const result: ConsolidationResult = { job: completed, extraction, proposal, operations };
      await this.publish("memory.consolidation.completed", result);
      return result;
    } catch (error) {
      const failed = await this.options.jobs.fail(job.id, this.errorMessage(error));
      await this.publish("memory.consolidation.failed", { job: failed, error: failed.lastError! });
      throw error;
    }
  }

  private async loadEvictedMessages(job: ConsolidationJob): Promise<HistoryMessage[]> {
    const messages: HistoryMessage[] = [];
    for (const messageId of job.evictedMessageIds) {
      const message = await this.options.history.get(job.sessionId, messageId);
      if (!message) throw new Error(`Consolidation source is missing from canonical History: ${messageId}`);
      messages.push(message);
    }
    return messages;
  }

  private assertCandidateGrounding(candidates: readonly HiddenMemoryCandidate[], job: ConsolidationJob): void {
    for (const candidate of candidates) {
      this.assertInferenceTrust(candidate.sourceType, candidate.confidence);
      this.assertSourcesGrounded(candidate.sourceReferences, job);
    }
  }

  private assertProposalGrounding(proposal: ConsolidationProposal, job: ConsolidationJob): void {
    for (const decision of proposal.decisions) {
      switch (decision.kind) {
        case "new":
          this.assertInferenceTrust(decision.candidate.sourceType, decision.candidate.confidence);
          this.assertSourcesGrounded(decision.candidate.sourceReferences, job);
          break;
        case "duplicate":
          this.assertSourcesGrounded(decision.sourceReferences, job);
          break;
        case "update":
          this.assertSourcesGrounded(decision.sourceReferences, job);
          if (decision.patch.sourceType === "assistant_inference" && decision.patch.confidence !== undefined) {
            this.assertInferenceTrust(decision.patch.sourceType, decision.patch.confidence);
          }
          break;
        case "supersede":
          this.assertInferenceTrust(decision.replacement.sourceType, decision.replacement.confidence);
          this.assertSourcesGrounded(decision.replacement.sourceReferences, job);
          break;
        case "contradiction":
          this.assertSourcesGrounded(decision.sourceReferences, job);
          break;
        case "irrelevant":
          break;
      }
    }
  }

  private assertSourcesGrounded(sources: readonly MemorySourceReference[], job: ConsolidationJob): void {
    const validIds = new Set(job.evictedMessageIds);
    for (const source of sources) {
      if (source.sessionId !== job.sessionId || !validIds.has(source.messageId)) {
        throw new Error(`Consolidation proposal references a message outside its evicted History: ${source.sessionId}:${source.messageId}`);
      }
    }
  }

  private assertInferenceTrust(sourceType: string, confidence: number): void {
    if (sourceType === "assistant_inference" && confidence > 0.5) {
      throw new Error("assistant_inference Memory must use confidence at or below 0.5");
    }
  }

  private async applyProposal(job: ConsolidationJob, proposal: ConsolidationProposal): Promise<ConsolidationOperation[]> {
    const operations: ConsolidationOperation[] = [];
    for (const [index, decision] of proposal.decisions.entries()) {
      switch (decision.kind) {
        case "new":
          operations.push(await this.applyNew(job, index, decision.candidate));
          break;
        case "duplicate":
          operations.push(await this.applyDuplicate(job, decision));
          break;
        case "update":
          operations.push(await this.applyUpdate(job, decision));
          break;
        case "supersede":
          operations.push(await this.applySupersede(job, index, decision));
          break;
        case "contradiction":
          throw new Error(`Contradiction for Memory ${decision.existingMemoryId} must be reconciled into update or supersede`);
        case "irrelevant":
          operations.push(decision.reason === undefined ? { kind: "irrelevant" } : { kind: "irrelevant", reason: decision.reason });
          break;
      }
    }
    return operations;
  }

  private async applyNew(job: ConsolidationJob, index: number, candidate: HiddenMemoryCandidate): Promise<ConsolidationOperation> {
    const id = deterministicMemoryId(job.deduplicationKey, `new:${index}`);
    const existing = await this.options.memories.get(id);
    if (existing) {
      await this.options.memories.refreshIndexes(existing.id);
      return { kind: "new", record: existing, applied: false };
    }
    const record = await this.options.memories.create({
      id,
      type: candidate.type,
      content: candidate.content,
      sourceReferences: candidate.sourceReferences,
      createdAt: job.createdAt,
      lastConfirmedAt: job.createdAt,
      importance: candidate.importance,
      confidence: candidate.confidence,
      sourceType: candidate.sourceType,
      status: candidate.status,
      entities: candidate.entities,
      tags: candidate.tags,
    });
    await this.publish("memory.created", { jobId: job.id, memory: record });
    return { kind: "new", record, applied: true };
  }

  private async applyDuplicate(job: ConsolidationJob, decision: Extract<ConsolidationDecision, { kind: "duplicate" }>): Promise<ConsolidationOperation> {
    const existing = await this.requireCurrentMemory(decision.existingMemoryId);
    const record = await this.options.memories.update(existing.id, {
      sourceReferences: mergeSources(existing.sourceReferences, decision.sourceReferences),
      lastConfirmedAt: job.createdAt,
    });
    await this.publish("memory.updated", { jobId: job.id, memory: record });
    return { kind: "duplicate", record };
  }

  private async applyUpdate(job: ConsolidationJob, decision: Extract<ConsolidationDecision, { kind: "update" }>): Promise<ConsolidationOperation> {
    const existing = await this.requireCurrentMemory(decision.existingMemoryId);
    const sourceType = decision.patch.sourceType ?? existing.sourceType;
    const confidence = decision.patch.confidence ?? existing.confidence;
    this.assertInferenceTrust(sourceType, confidence);
    const record = await this.options.memories.update(existing.id, {
      ...decision.patch,
      sourceReferences: mergeSources(existing.sourceReferences, decision.sourceReferences),
      lastConfirmedAt: job.createdAt,
    });
    await this.publish("memory.updated", { jobId: job.id, memory: record });
    return { kind: "update", record };
  }

  private async applySupersede(job: ConsolidationJob, index: number, decision: Extract<ConsolidationDecision, { kind: "supersede" }>): Promise<ConsolidationOperation> {
    const replacementId = deterministicMemoryId(job.deduplicationKey, `supersede:${index}`);
    const previous = await this.options.memories.get(decision.existingMemoryId);
    if (!previous) throw new Error(`Memory not found: ${decision.existingMemoryId}`);
    if (previous.status === "superseded") {
      if (previous.supersededBy !== replacementId) throw new Error(`Memory ${previous.id} has already been superseded by a different record`);
      const replacement = await this.options.memories.get(replacementId);
      if (!replacement) throw new Error(`Superseding Memory ${replacementId} is missing`);
      await this.options.memories.refreshIndexes(previous.id);
      await this.options.memories.refreshIndexes(replacement.id);
      return { kind: "supersede", superseded: previous, replacement, applied: false };
    }
    if (previous.status === "archived") throw new Error(`Archived Memory cannot be superseded: ${previous.id}`);

    let replacement = await this.options.memories.get(replacementId);
    if (!replacement) {
      replacement = await this.options.memories.create({
        id: replacementId,
        type: decision.replacement.type,
        content: decision.replacement.content,
        sourceReferences: decision.replacement.sourceReferences,
        createdAt: job.createdAt,
        lastConfirmedAt: job.createdAt,
        importance: decision.replacement.importance,
        confidence: decision.replacement.confidence,
        sourceType: decision.replacement.sourceType,
        status: decision.replacement.status,
        entities: decision.replacement.entities,
        tags: decision.replacement.tags,
      });
      await this.publish("memory.created", { jobId: job.id, memory: replacement });
    }
    // MemoryStore.supersede is the Phase 3 atomic status transition and remains the sole implementation.
    const relation = await this.options.memories.supersede(previous.id, replacement.id);
    await this.publish("memory.superseded", { jobId: job.id, superseded: relation.superseded, replacement: relation.replacement });
    return { kind: "supersede", superseded: relation.superseded, replacement: relation.replacement, applied: true };
  }

  private async requireCurrentMemory(id: string): Promise<MemoryRecord> {
    const memory = await this.options.memories.get(id);
    if (!memory) throw new Error(`Memory not found: ${id}`);
    if (memory.status !== "active" && memory.status !== "provisional") {
      throw new Error(`Consolidation can only modify active or provisional Memory: ${id}`);
    }
    return memory;
  }

  private async publish<K extends keyof HarnessEventMap>(event: K, payload: HarnessEventMap[K]): Promise<void> {
    if (!this.options.events) return;
    try {
      await this.options.events.emit(event, payload);
    } catch (error) {
      // Events are observability hooks; a subscriber must not corrupt a completed write or job transition.
      this.report(error);
    }
  }

  private report(error: unknown): void {
    this.options.onBackgroundError?.(error instanceof Error ? error : new Error(String(error)));
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

function mergeSources(existing: readonly MemorySourceReference[], additions: readonly MemorySourceReference[]): MemorySourceReference[] {
  const merged = new Map<string, MemorySourceReference>();
  for (const source of [...existing, ...additions]) merged.set(`${source.sessionId}:${source.messageId}`, source);
  return [...merged.values()];
}

/** Deterministic UUIDv4-shaped IDs make post-crash retries converge on the same record. */
export function deterministicMemoryId(jobKey: string, operation: string): string {
  const bytes = Buffer.from(createHash("sha256").update(`${jobKey}:${operation}`).digest("hex").slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
