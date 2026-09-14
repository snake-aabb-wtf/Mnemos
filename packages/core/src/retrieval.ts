import { createHash } from "node:crypto";
import { z } from "zod";
import {
  memorySourceTypeSchema,
  memoryScopeKindSchema,
  memoryStatusSchema,
  memoryTypeSchema,
  type MemoryIndexMaintainer,
  type MemoryRecord,
  type MemoryService,
  type MemorySourceType,
  type MemoryStatus,
  type MemoryType,
} from "./memory.js";
import { defaultMemoryDecayPolicy, memoryIntelligenceSignals, type MemoryDecayPolicy } from "./memory-intelligence.js";

const textSchema = z.string().trim().min(1);
const vectorSchema = z.array(z.number().finite()).min(1);

export const embeddingModelDescriptorSchema = z.object({
  model: textSchema,
  version: textSchema,
  dimensions: z.number().int().positive(),
}).strict();
export type EmbeddingModelDescriptor = z.infer<typeof embeddingModelDescriptorSchema>;

/** Provider-neutral embedding boundary. Core never imports a vendor SDK. */
export interface EmbeddingProvider {
  readonly descriptor: EmbeddingModelDescriptor;
  embed(input: string): Promise<readonly number[]>;
}

/** A local, deterministic baseline for tests and offline development; not a semantic model. */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly descriptor: EmbeddingModelDescriptor;

  constructor(descriptor: Partial<EmbeddingModelDescriptor> = {}) {
    this.descriptor = embeddingModelDescriptorSchema.parse({
      model: descriptor.model ?? "deterministic-token-hash",
      version: descriptor.version ?? "v1",
      dimensions: descriptor.dimensions ?? 64,
    });
  }

  async embed(input: string): Promise<readonly number[]> {
    const values = Array.from({ length: this.descriptor.dimensions }, () => 0);
    const tokens = input.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [input.toLocaleLowerCase()];
    for (const token of tokens) {
      const hash = stableHash(token);
      const slot = hash % values.length;
      values[slot] += (hash & 1) === 0 ? 1 : -1;
    }
    return normalizeVector(values);
  }
}

export const memoryVectorRecordSchema = z.object({
  memoryId: z.string().uuid(),
  values: vectorSchema,
  dimensions: z.number().int().positive(),
  model: textSchema,
  modelVersion: textSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  type: memoryTypeSchema,
  status: memoryStatusSchema,
  sourceType: memorySourceTypeSchema,
  confidence: z.number().min(0).max(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  entities: z.array(textSchema),
  tags: z.array(textSchema),
  sessionIds: z.array(textSchema),
  scopeKind: memoryScopeKindSchema.optional(),
  scopeId: textSchema.optional(),
  indexedAt: z.string().datetime(),
}).strict().superRefine((record, context) => {
  if (record.values.length !== record.dimensions) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Vector dimensions must match values length" });
  }
});
export type MemoryVectorRecord = z.infer<typeof memoryVectorRecordSchema>;

export interface MemoryVectorFilters {
  types?: MemoryType[];
  statuses?: MemoryStatus[];
  sourceTypes?: MemorySourceType[];
  entities?: string[];
  tags?: string[];
  minimumConfidence?: number;
  before?: string;
  after?: string;
  sessionId?: string;
  scopeKind?: MemoryRecord["scope"]["kind"];
  scopeId?: string;
}

export interface MemoryVectorSearchQuery {
  values: readonly number[];
  descriptor: EmbeddingModelDescriptor;
  filters?: MemoryVectorFilters;
  limit: number;
}

export interface MemoryVectorSearchHit {
  memoryId: string;
  /** Cosine similarity in [-1, 1]. It is never directly added to lexical BM25 scores. */
  score: number;
}

/** Derived local vector-index boundary. Deleting it is safe because it can be rebuilt from MemoryStore. */
export interface MemoryVectorStore {
  get(memoryId: string): Promise<MemoryVectorRecord | undefined>;
  upsert(record: MemoryVectorRecord): Promise<void>;
  search(query: MemoryVectorSearchQuery): Promise<readonly MemoryVectorSearchHit[]>;
  replaceAll(records: readonly MemoryVectorRecord[]): Promise<void>;
  clear(): Promise<void>;
  count(): Promise<number>;
}

export const memoryRetrievalQuerySchema = z.object({
  query: textSchema,
  limit: z.number().int().min(1).max(100).default(10),
  types: z.array(memoryTypeSchema).min(1).optional(),
  /** Defaults to current facts. Supply superseded explicitly for historical questions. */
  statuses: z.array(memoryStatusSchema).min(1).default(["active"]),
  sourceTypes: z.array(memorySourceTypeSchema).min(1).optional(),
  entities: z.array(textSchema).min(1).optional(),
  tags: z.array(textSchema).min(1).optional(),
  minimumConfidence: z.number().min(0).max(1).optional(),
  before: z.string().datetime().optional(),
  after: z.string().datetime().optional(),
  sessionId: textSchema.optional(),
  scopeKind: z.enum(["global", "user", "project", "session", "entity"]).optional(),
  scopeId: textSchema.optional(),
}).strict().refine((query) => query.before === undefined || query.after === undefined || query.before >= query.after, "before must be at or after after");
export type MemoryRetrievalQuery = z.input<typeof memoryRetrievalQuerySchema>;

export type MemoryRetrievalMatch = "lexical" | "semantic" | "entity" | "metadata" | "temporal";

export interface MemoryRetrievalSignals {
  /** Rank-normalized RRF contribution, not an incompatible raw FTS score. */
  lexical?: number;
  /** Rank-normalized RRF contribution, not an incompatible raw cosine score. */
  semantic?: number;
  entity?: number;
  recency?: number;
  confidence?: number;
  status?: number;
  reinforcement?: number;
  decay?: number;
  stale?: number;
}

export interface MemoryRetrievalResult {
  memory: MemoryRecord;
  score: number;
  rank: number;
  signals: MemoryRetrievalSignals;
  matchedBy: readonly MemoryRetrievalMatch[];
}

/** The only retrieval contract used by hidden consolidation and future visible agents. */
export interface MemoryRetriever {
  retrieve(query: MemoryRetrievalQuery): Promise<readonly MemoryRetrievalResult[]>;
}

export interface MemoryRerankCandidate {
  memory: MemoryRecord;
  fusedScore: number;
  signals: MemoryRetrievalSignals;
  matchedBy: Set<MemoryRetrievalMatch>;
}

export interface MemoryRerankRequest {
  query: z.output<typeof memoryRetrievalQuerySchema>;
  candidates: readonly MemoryRerankCandidate[];
}

/** Reranking is separate so a future cross-encoder can replace only this component. */
export interface MemoryReranker {
  rerank(request: MemoryRerankRequest): Promise<readonly MemoryRetrievalResult[]>;
}

export interface DeterministicMemoryRerankerOptions {
  now?: () => Date;
  recencyHalfLifeDays?: number;
  statusWeight?: number;
  confidenceWeight?: number;
  recencyWeight?: number;
  intelligencePolicy?: MemoryDecayPolicy;
  reinforcementWeight?: number;
  decayWeight?: number;
  staleWeight?: number;
}

/** A deterministic domain-aware reranker; status and confidence outweigh pure recency. */
export class DeterministicMemoryReranker implements MemoryReranker {
  private readonly now: () => Date;
  private readonly halfLifeMs: number;
  private readonly statusWeight: number;
  private readonly confidenceWeight: number;
  private readonly recencyWeight: number;
  private readonly intelligencePolicy: MemoryDecayPolicy;
  private readonly reinforcementWeight: number;
  private readonly decayWeight: number;
  private readonly staleWeight: number;

  constructor(options: DeterministicMemoryRerankerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.halfLifeMs = (options.recencyHalfLifeDays ?? 90) * 24 * 60 * 60 * 1_000;
    this.statusWeight = options.statusWeight ?? 0.06;
    this.confidenceWeight = options.confidenceWeight ?? 0.04;
    this.recencyWeight = options.recencyWeight ?? 0.02;
    this.intelligencePolicy = options.intelligencePolicy ?? defaultMemoryDecayPolicy;
    // Keep Phase 5 fused-rank behavior dominant; intelligence signals are
    // bounded tie-breakers rather than a way for an unrelated fresh record to
    // outrank an exact lexical match.
    this.reinforcementWeight = options.reinforcementWeight ?? 0.004;
    this.decayWeight = options.decayWeight ?? 0.003;
    this.staleWeight = options.staleWeight ?? 0.01;
  }

  async rerank(request: MemoryRerankRequest): Promise<readonly MemoryRetrievalResult[]> {
    const now = this.now().getTime();
    const results = request.candidates.map((candidate) => {
      const recency = this.recency(candidate.memory.updatedAt, now);
      const status = statusSignal(candidate.memory.status);
      const intelligence = memoryIntelligenceSignals(candidate.memory, new Date(now), this.intelligencePolicy);
      const signals: MemoryRetrievalSignals = {
        ...candidate.signals,
        recency,
        confidence: candidate.memory.confidence,
        status,
        reinforcement: intelligence.reinforcement,
        decay: intelligence.decay,
        stale: intelligence.stale,
      };
      const score = candidate.fusedScore
        + status * this.statusWeight
        + candidate.memory.confidence * this.confidenceWeight
        + recency * this.recencyWeight
        + intelligence.reinforcement * this.reinforcementWeight
        + intelligence.decay * this.decayWeight
        - (candidate.memory.stale ? this.staleWeight : 0);
      const matchedBy = new Set(candidate.matchedBy);
      if (request.query.before !== undefined || request.query.after !== undefined || this.recencyWeight > 0) matchedBy.add("temporal");
      if (hasMetadataFilters(request.query)) matchedBy.add("metadata");
      return { memory: candidate.memory, score, rank: 0, signals, matchedBy: [...matchedBy] };
    });
    results.sort((left, right) => right.score - left.score
      || right.signals.status! - left.signals.status!
      || right.memory.updatedAt.localeCompare(left.memory.updatedAt)
      || left.memory.id.localeCompare(right.memory.id));
    return results.map((result, index) => ({ ...result, rank: index + 1 }));
  }

  private recency(updatedAt: string, now: number): number {
    const age = Math.max(0, now - new Date(updatedAt).getTime());
    return Math.exp(-age / this.halfLifeMs);
  }
}

export interface HybridMemoryRetrieverOptions {
  memories: Pick<MemoryService, "search" | "list" | "getMany">;
  embeddings: EmbeddingProvider;
  vectors: MemoryVectorStore;
  reranker?: MemoryReranker;
  candidateLimit?: number;
  reciprocalRankConstant?: number;
  lexicalWeight?: number;
  semanticWeight?: number;
  entityWeight?: number;
}

/**
 * Phase 5 query pipeline: lexical/vector/entity candidates are independently
 * retrieved, metadata-filtered, fused with RRF, then reranked deterministically.
 */
export class HybridMemoryRetriever implements MemoryRetriever {
  private readonly reranker: MemoryReranker;
  private readonly candidateLimit: number;
  private readonly rrfConstant: number;
  private readonly lexicalWeight: number;
  private readonly semanticWeight: number;
  private readonly entityWeight: number;

  constructor(private readonly options: HybridMemoryRetrieverOptions) {
    this.reranker = options.reranker ?? new DeterministicMemoryReranker();
    this.candidateLimit = options.candidateLimit ?? 40;
    this.rrfConstant = options.reciprocalRankConstant ?? 60;
    this.lexicalWeight = options.lexicalWeight ?? 1;
    this.semanticWeight = options.semanticWeight ?? 1;
    this.entityWeight = options.entityWeight ?? 0.8;
  }

  async retrieve(input: MemoryRetrievalQuery): Promise<readonly MemoryRetrievalResult[]> {
    const query = memoryRetrievalQuerySchema.parse(input);
    const filters = toFilters(query);
    const entityTerms = query.entities ?? entityTermsFromQuery(query.query);
    const [lexical, queryVector, entity] = await Promise.all([
      this.options.memories.search({ query: query.query, ...filters, limit: this.candidateLimit }),
      this.options.embeddings.embed(query.query),
      entityTerms.length === 0
        ? Promise.resolve([] as MemoryRecord[])
        : this.options.memories.list({ ...filters, entities: entityTerms, limit: this.candidateLimit }),
    ]);
    const semantic = await this.options.vectors.search({
      values: queryVector,
      descriptor: this.options.embeddings.descriptor,
      filters,
      limit: this.candidateLimit,
    });
    const ranks = new Map<string, Partial<Record<"lexical" | "semantic" | "entity", number>>>();
    addRanks(ranks, lexical.map((result) => result.memory.id), "lexical");
    addRanks(ranks, semantic.map((result) => result.memoryId), "semantic");
    addRanks(ranks, entity.map((record) => record.id), "entity");
    if (ranks.size === 0) return [];

    const records = await this.options.memories.getMany([...ranks.keys()]);
    const candidates: MemoryRerankCandidate[] = records
      .filter((record) => matchesFilters(record, query))
      .map((memory) => {
        const rank = ranks.get(memory.id)!;
        const signals: MemoryRetrievalSignals = {};
        const matchedBy = new Set<MemoryRetrievalMatch>();
        if (rank.lexical !== undefined) {
          signals.lexical = this.rrf(this.lexicalWeight, rank.lexical);
          matchedBy.add("lexical");
        }
        if (rank.semantic !== undefined) {
          signals.semantic = this.rrf(this.semanticWeight, rank.semantic);
          matchedBy.add("semantic");
        }
        if (rank.entity !== undefined) {
          signals.entity = this.rrf(this.entityWeight, rank.entity);
          matchedBy.add("entity");
        }
        return {
          memory,
          fusedScore: Object.values(signals).reduce((total, value) => total + (value ?? 0), 0),
          signals,
          matchedBy,
        };
      });
    return (await this.reranker.rerank({ query, candidates })).slice(0, query.limit);
  }

  private rrf(weight: number, rank: number): number {
    return weight / (this.rrfConstant + rank);
  }
}

/** A compatibility implementation for hosts that have not enabled a vector index yet. */
export class LexicalMemoryRetriever implements MemoryRetriever {
  constructor(private readonly memories: Pick<MemoryService, "search">, private readonly reranker: MemoryReranker = new DeterministicMemoryReranker()) {}

  async retrieve(input: MemoryRetrievalQuery): Promise<readonly MemoryRetrievalResult[]> {
    const query = memoryRetrievalQuerySchema.parse(input);
    const records = await this.memories.search({ query: query.query, ...toFilters(query), limit: query.limit });
    const candidates: MemoryRerankCandidate[] = records.map((result, index) => ({
      memory: result.memory,
      fusedScore: 1 / (60 + index + 1),
      signals: { lexical: 1 / (60 + index + 1) },
      matchedBy: new Set<MemoryRetrievalMatch>(["lexical"]),
    }));
    return this.reranker.rerank({ query, candidates });
  }
}

/** Synchronizes Memory mutations with a rebuildable derived vector index. */
export class MemoryEmbeddingIndexer implements MemoryIndexMaintainer {
  constructor(
    private readonly embeddings: EmbeddingProvider,
    private readonly vectors: MemoryVectorStore,
    private readonly memories?: Pick<MemoryService, "list">,
  ) {}

  onCreated(memory: MemoryRecord): Promise<void> {
    return this.sync(memory);
  }

  onUpdated(memory: MemoryRecord): Promise<void> {
    return this.sync(memory);
  }

  async onSuperseded(relation: { superseded: MemoryRecord; replacement: MemoryRecord }): Promise<void> {
    await this.sync(relation.superseded);
    await this.sync(relation.replacement);
  }

  /** Replaces the entire derived index. Canonical Memory remains untouched if this fails. */
  async rebuild(): Promise<number> {
    if (!this.memories) throw new Error("MemoryEmbeddingIndexer.rebuild requires a MemoryService list capability");
    const memories = await this.memories.list({
      statuses: ["active", "provisional", "superseded", "archived"],
      limit: 20_000,
    });
    const records: MemoryVectorRecord[] = [];
    for (const memory of memories) records.push(await this.toVectorRecord(memory));
    await this.vectors.replaceAll(records);
    return records.length;
  }

  private async sync(memory: MemoryRecord): Promise<void> {
    const contentHash = hashContent(memory.content);
    const existing = await this.vectors.get(memory.id);
    const sameEmbedding = existing !== undefined
      && existing.contentHash === contentHash
      && existing.model === this.embeddings.descriptor.model
      && existing.modelVersion === this.embeddings.descriptor.version
      && existing.dimensions === this.embeddings.descriptor.dimensions;
    const values = sameEmbedding ? existing.values : await this.embed(memory.content);
    await this.vectors.upsert(this.record(memory, values, contentHash));
  }

  private async toVectorRecord(memory: MemoryRecord): Promise<MemoryVectorRecord> {
    return this.record(memory, await this.embed(memory.content), hashContent(memory.content));
  }

  private async embed(content: string): Promise<readonly number[]> {
    const values = [...await this.embeddings.embed(content)];
    if (values.length !== this.embeddings.descriptor.dimensions || values.some((value) => !Number.isFinite(value))) {
      throw new Error(`EmbeddingProvider returned an invalid ${values.length}-dimension embedding`);
    }
    return normalizeVector(values);
  }

  private record(memory: MemoryRecord, values: readonly number[], contentHash: string): MemoryVectorRecord {
    return memoryVectorRecordSchema.parse({
      memoryId: memory.id,
      values,
      dimensions: this.embeddings.descriptor.dimensions,
      model: this.embeddings.descriptor.model,
      modelVersion: this.embeddings.descriptor.version,
      contentHash,
      type: memory.type,
      status: memory.status,
      sourceType: memory.sourceType,
      confidence: memory.confidence,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
      entities: memory.entities,
      tags: memory.tags,
      sessionIds: [...new Set(memory.sourceReferences.map((source) => source.sessionId))],
      scopeKind: memory.scope.kind,
      scopeId: memory.scope.id,
      indexedAt: new Date().toISOString(),
    });
  }
}

function addRanks(target: Map<string, Partial<Record<"lexical" | "semantic" | "entity", number>>>, ids: readonly string[], source: "lexical" | "semantic" | "entity"): void {
  ids.forEach((id, index) => {
    const current = target.get(id) ?? {};
    current[source] = Math.min(current[source] ?? Number.POSITIVE_INFINITY, index + 1);
    target.set(id, current);
  });
}

function toFilters(query: z.output<typeof memoryRetrievalQuerySchema>): MemoryVectorFilters {
  return {
    ...(query.types === undefined ? {} : { types: query.types }),
    statuses: query.statuses,
    ...(query.sourceTypes === undefined ? {} : { sourceTypes: query.sourceTypes }),
    ...(query.entities === undefined ? {} : { entities: query.entities }),
    ...(query.tags === undefined ? {} : { tags: query.tags }),
    ...(query.minimumConfidence === undefined ? {} : { minimumConfidence: query.minimumConfidence }),
    ...(query.before === undefined ? {} : { before: query.before }),
    ...(query.after === undefined ? {} : { after: query.after }),
    ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
    ...(query.scopeKind === undefined ? {} : { scopeKind: query.scopeKind }),
    ...(query.scopeId === undefined ? {} : { scopeId: query.scopeId }),
  };
}

function matchesFilters(memory: MemoryRecord, query: z.output<typeof memoryRetrievalQuerySchema>): boolean {
  if (!query.statuses.includes(memory.status)) return false;
  if (query.types !== undefined && !query.types.includes(memory.type)) return false;
  if (query.sourceTypes !== undefined && !query.sourceTypes.includes(memory.sourceType)) return false;
  if (query.minimumConfidence !== undefined && memory.confidence < query.minimumConfidence) return false;
  if (query.before !== undefined && memory.createdAt > query.before) return false;
  if (query.after !== undefined && memory.createdAt < query.after) return false;
  if (query.entities !== undefined && !memory.entities.some((entity) => query.entities!.some((expected) => entity.toLocaleLowerCase() === expected.toLocaleLowerCase()))) return false;
  if (query.tags !== undefined && !memory.tags.some((tag) => query.tags!.some((expected) => tag.toLocaleLowerCase() === expected.toLocaleLowerCase()))) return false;
  if (query.scopeKind !== undefined && memory.scope.kind !== query.scopeKind) return false;
  if (query.scopeId !== undefined && memory.scope.id !== query.scopeId) return false;
  return query.sessionId === undefined || memory.sourceReferences.some((source) => source.sessionId === query.sessionId);
}

function entityTermsFromQuery(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])].filter((term) => term.length >= 2).slice(0, 12);
}

function hasMetadataFilters(query: z.output<typeof memoryRetrievalQuerySchema>): boolean {
  return query.types !== undefined || query.sourceTypes !== undefined || query.entities !== undefined
    || query.tags !== undefined || query.minimumConfidence !== undefined || query.sessionId !== undefined
    || query.scopeKind !== undefined || query.scopeId !== undefined;
}

function statusSignal(status: MemoryStatus): number {
  switch (status) {
    case "active": return 1;
    case "provisional": return 0.75;
    case "superseded": return 0.3;
    case "archived": return 0.1;
  }
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function normalizeVector(values: readonly number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return values.map((_, index) => index === 0 ? 1 : 0);
  return values.map((value) => value / norm);
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
