import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { HistoryMessage, HistoryStore } from "./contracts.js";

export const memoryTypeSchema = z.enum(["semantic", "episodic", "decision", "preference", "entity"]);
export type MemoryType = z.infer<typeof memoryTypeSchema>;

export const memorySourceTypeSchema = z.enum([
  "explicit_user_statement",
  "tool_observation",
  "assistant_inference",
  "derived_summary",
]);
export type MemorySourceType = z.infer<typeof memorySourceTypeSchema>;

export const memoryStatusSchema = z.enum(["active", "provisional", "superseded", "archived"]);
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;

export const memoryIdSchema = z.string().uuid();
const nonEmptyTextSchema = z.string().trim().min(1);

export const memoryDurabilitySchema = z.enum(["durable", "normal", "ephemeral"]);
export type MemoryDurability = z.infer<typeof memoryDurabilitySchema>;

export const memoryScopeKindSchema = z.enum(["global", "user", "project", "session", "entity"]);
export const memoryScopeSchema = z.object({
  kind: memoryScopeKindSchema,
  id: nonEmptyTextSchema,
}).default({ kind: "global", id: "global" });
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const memoryEntityRelationTypeSchema = z.enum([
  "uses",
  "belongs_to",
  "depends_on",
  "related_to",
  "supersedes",
  "part_of",
  "runs_on",
]);
export type MemoryEntityRelationType = z.infer<typeof memoryEntityRelationTypeSchema>;

export const memoryEntityRelationSchema = z.object({
  from: nonEmptyTextSchema,
  relation: memoryEntityRelationTypeSchema,
  to: nonEmptyTextSchema,
}).strict();
export type MemoryEntityRelation = z.infer<typeof memoryEntityRelationSchema>;

/** A stable History address. Session ID is required because HistoryStore is session-scoped. */
export const memorySourceReferenceSchema = z.object({
  sessionId: nonEmptyTextSchema,
  messageId: memoryIdSchema,
});
export type MemorySourceReference = z.infer<typeof memorySourceReferenceSchema>;

const metadataValuesSchema = z.array(nonEmptyTextSchema).default([]);

export const memoryRecordSchema = z.object({
  id: memoryIdSchema,
  type: memoryTypeSchema,
  content: nonEmptyTextSchema,
  /** Kept as direct IDs for simple provenance inspection; derived from sourceReferences. */
  sourceIds: z.array(memoryIdSchema).min(1),
  sourceReferences: z.array(memorySourceReferenceSchema).min(1).refine(
    (sources) => new Set(sources.map((source) => `${source.sessionId}:${source.messageId}`)).size === sources.length,
    "sourceReferences cannot contain duplicates",
  ),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastConfirmedAt: z.string().datetime().optional(),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  sourceType: memorySourceTypeSchema,
  status: memoryStatusSchema,
  supersededBy: memoryIdSchema.optional(),
  mergedInto: memoryIdSchema.optional(),
  derivedFromMemoryIds: z.array(memoryIdSchema).default([]),
  confirmationCount: z.number().int().nonnegative().default(1),
  reinforcementScore: z.number().min(0).max(1).default(0),
  lastReinforcedAt: z.string().datetime().optional(),
  stale: z.boolean().default(false),
  staleSince: z.string().datetime().optional(),
  durability: memoryDurabilitySchema.default("normal"),
  scope: memoryScopeSchema,
  entityRelations: z.array(memoryEntityRelationSchema).default([]),
  entities: metadataValuesSchema,
  tags: metadataValuesSchema,
}).superRefine((record, context) => {
  if (record.sourceIds.length !== record.sourceReferences.length
    || record.sourceIds.some((id, index) => id !== record.sourceReferences[index].messageId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "sourceIds must mirror sourceReferences in order" });
  }
  if (record.status === "superseded" && record.supersededBy === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Superseded memory requires supersededBy" });
  }
  if (record.status !== "superseded" && record.supersededBy !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Only superseded memory may have supersededBy" });
  }
  if (record.mergedInto === record.id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Memory cannot be merged into itself" });
  }
  if (record.status !== "archived" && record.mergedInto !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Only archived Memory may have mergedInto" });
  }
});
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

export const memoryCreateInputSchema = z.object({
  id: memoryIdSchema.optional(),
  type: memoryTypeSchema,
  content: nonEmptyTextSchema,
  sourceReferences: z.array(memorySourceReferenceSchema).min(1).refine(
    (sources) => new Set(sources.map((source) => `${source.sessionId}:${source.messageId}`)).size === sources.length,
    "sourceReferences cannot contain duplicates",
  ),
  createdAt: z.string().datetime().optional(),
  lastConfirmedAt: z.string().datetime().optional(),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  sourceType: memorySourceTypeSchema,
  status: z.enum(["active", "provisional", "archived"]).default("provisional"),
  mergedInto: memoryIdSchema.optional(),
  derivedFromMemoryIds: z.array(memoryIdSchema).default([]),
  confirmationCount: z.number().int().nonnegative().default(1),
  reinforcementScore: z.number().min(0).max(1).default(0),
  lastReinforcedAt: z.string().datetime().optional(),
  stale: z.boolean().default(false),
  staleSince: z.string().datetime().optional(),
  durability: memoryDurabilitySchema.default("normal"),
  scope: memoryScopeSchema,
  entityRelations: z.array(memoryEntityRelationSchema).default([]),
  entities: metadataValuesSchema,
  tags: metadataValuesSchema,
});
export type MemoryCreateInput = z.input<typeof memoryCreateInputSchema>;

export const memoryUpdateInputSchema = z.object({
  type: memoryTypeSchema.optional(),
  content: nonEmptyTextSchema.optional(),
  sourceReferences: z.array(memorySourceReferenceSchema).min(1).refine(
    (sources) => new Set(sources.map((source) => `${source.sessionId}:${source.messageId}`)).size === sources.length,
    "sourceReferences cannot contain duplicates",
  ).optional(),
  lastConfirmedAt: z.string().datetime().nullable().optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceType: memorySourceTypeSchema.optional(),
  /** Superseded status is only assigned by the atomic supersede operation. */
  status: z.enum(["active", "provisional", "archived"]).optional(),
  mergedInto: memoryIdSchema.nullable().optional(),
  derivedFromMemoryIds: z.array(memoryIdSchema).optional(),
  confirmationCount: z.number().int().nonnegative().optional(),
  reinforcementScore: z.number().min(0).max(1).optional(),
  lastReinforcedAt: z.string().datetime().nullable().optional(),
  stale: z.boolean().optional(),
  staleSince: z.string().datetime().nullable().optional(),
  durability: memoryDurabilitySchema.optional(),
  scope: memoryScopeSchema.optional(),
  entityRelations: z.array(memoryEntityRelationSchema).optional(),
  entities: metadataValuesSchema.optional(),
  tags: metadataValuesSchema.optional(),
}).refine((input) => Object.keys(input).length > 0, "Memory update cannot be empty");
export type MemoryUpdateInput = z.input<typeof memoryUpdateInputSchema>;

export const memorySearchQuerySchema = z.object({
  query: nonEmptyTextSchema,
  types: z.array(memoryTypeSchema).min(1).optional(),
  statuses: z.array(memoryStatusSchema).min(1).optional(),
  sourceTypes: z.array(memorySourceTypeSchema).min(1).optional(),
  entities: z.array(nonEmptyTextSchema).min(1).optional(),
  tags: z.array(nonEmptyTextSchema).min(1).optional(),
  minimumConfidence: z.number().min(0).max(1).optional(),
  before: z.string().datetime().optional(),
  after: z.string().datetime().optional(),
  /** Restricts results to memories with at least one source in this session. */
  sessionId: nonEmptyTextSchema.optional(),
  scopeKind: memoryScopeKindSchema.optional(),
  scopeId: nonEmptyTextSchema.optional(),
  limit: z.number().int().min(1).max(100).default(10),
}).refine((query) => query.before === undefined || query.after === undefined || query.before >= query.after, "before must be at or after after");
export type MemorySearchQuery = z.input<typeof memorySearchQuerySchema>;

export const memoryListQuerySchema = z.object({
  types: z.array(memoryTypeSchema).min(1).optional(),
  statuses: z.array(memoryStatusSchema).min(1).optional(),
  sourceTypes: z.array(memorySourceTypeSchema).min(1).optional(),
  entities: z.array(nonEmptyTextSchema).min(1).optional(),
  tags: z.array(nonEmptyTextSchema).min(1).optional(),
  minimumConfidence: z.number().min(0).max(1).optional(),
  before: z.string().datetime().optional(),
  after: z.string().datetime().optional(),
  sessionId: nonEmptyTextSchema.optional(),
  scopeKind: memoryScopeKindSchema.optional(),
  scopeId: nonEmptyTextSchema.optional(),
  /** Rebuilds may read more than the interactive default, but callers must opt in. */
  limit: z.number().int().min(1).max(20_000).default(100),
}).refine((query) => query.before === undefined || query.after === undefined || query.before >= query.after, "before must be at or after after");
export type MemoryListQuery = z.input<typeof memoryListQuerySchema>;

export const memoryTimelineQuerySchema = z.object({
  entity: nonEmptyTextSchema.optional(),
  tag: nonEmptyTextSchema.optional(),
  types: z.array(memoryTypeSchema).min(1).optional(),
  statuses: z.array(memoryStatusSchema).min(1).optional(),
  limit: z.number().int().min(1).max(500).default(100),
}).refine((query) => query.entity !== undefined || query.tag !== undefined, "Timeline requires an entity or tag");
export type MemoryTimelineQuery = z.input<typeof memoryTimelineQuerySchema>;

export interface MemorySearchResult {
  memory: MemoryRecord;
  /** SQLite FTS5 bm25 score where lower is a stronger lexical result. */
  score: number;
}

export interface MemoryStore {
  create(input: MemoryCreateInput): Promise<MemoryRecord>;
  get(id: string): Promise<MemoryRecord | undefined>;
  getMany(ids: readonly string[]): Promise<MemoryRecord[]>;
  update(id: string, update: MemoryUpdateInput): Promise<MemoryRecord>;
  search(query: MemorySearchQuery): Promise<MemorySearchResult[]>;
  list(query?: MemoryListQuery): Promise<MemoryRecord[]>;
  supersede(supersededId: string, replacementId: string): Promise<{ superseded: MemoryRecord; replacement: MemoryRecord }>;
  timeline(query: MemoryTimelineQuery): Promise<MemoryRecord[]>;
}

/** A derived-index hook. Index failures never alter History, and every index can be rebuilt from MemoryStore. */
export interface MemoryIndexMaintainer {
  onCreated(memory: MemoryRecord): Promise<void>;
  onUpdated(memory: MemoryRecord): Promise<void>;
  onSuperseded(relation: { superseded: MemoryRecord; replacement: MemoryRecord }): Promise<void>;
}

export class MemoryNotFoundError extends Error {
  constructor(id: string) {
    super(`Memory not found: ${id}`);
    this.name = "MemoryNotFoundError";
  }
}

export class MemorySourceNotFoundError extends Error {
  constructor(readonly memoryId: string, readonly source: MemorySourceReference) {
    super(`Memory ${memoryId} references missing History message ${source.messageId} in session ${source.sessionId}`);
    this.name = "MemorySourceNotFoundError";
  }
}

export interface MemorySourceTrace {
  memory: MemoryRecord;
  messages: readonly HistoryMessage[];
}

/**
 * Memory-domain API for source validation and History tracing. It deliberately
 * has no event subscription: Phase 4 owns automated eviction consolidation.
 */
export class MemoryService {
  constructor(
    private readonly memories: MemoryStore,
    private readonly history: HistoryStore,
    private readonly indexMaintainer?: MemoryIndexMaintainer,
  ) {}

  async create(input: MemoryCreateInput): Promise<MemoryRecord> {
    const parsed = memoryCreateInputSchema.parse(input);
    const id = parsed.id ?? randomUUID();
    await this.assertSourcesExist(parsed.sourceReferences, id);
    const record = await this.memories.create({ ...parsed, id });
    await this.indexMaintainer?.onCreated(record);
    return record;
  }

  get(id: string): Promise<MemoryRecord | undefined> {
    return this.memories.get(memoryIdSchema.parse(id));
  }

  getMany(ids: readonly string[]): Promise<MemoryRecord[]> {
    return this.memories.getMany(ids.map((id) => memoryIdSchema.parse(id)));
  }

  /** Retries a derived-index update after a prior provider/index failure without mutating canonical Memory. */
  async refreshIndexes(id: string): Promise<MemoryRecord> {
    const memoryId = memoryIdSchema.parse(id);
    const record = await this.memories.get(memoryId);
    if (!record) throw new MemoryNotFoundError(memoryId);
    await this.indexMaintainer?.onUpdated(record);
    return record;
  }

  async update(id: string, update: MemoryUpdateInput): Promise<MemoryRecord> {
    const memoryId = memoryIdSchema.parse(id);
    const parsed = memoryUpdateInputSchema.parse(update);
    if (parsed.sourceReferences !== undefined) await this.assertSourcesExist(parsed.sourceReferences, memoryId);
    const record = await this.memories.update(memoryId, parsed);
    await this.indexMaintainer?.onUpdated(record);
    return record;
  }

  list(query?: MemoryListQuery): Promise<MemoryRecord[]> {
    return this.memories.list(query === undefined ? undefined : memoryListQuerySchema.parse(query));
  }

  search(query: MemorySearchQuery): Promise<MemorySearchResult[]> {
    return this.memories.search(memorySearchQuerySchema.parse(query));
  }

  timeline(query: MemoryTimelineQuery): Promise<MemoryRecord[]> {
    return this.memories.timeline(memoryTimelineQuerySchema.parse(query));
  }

  async supersede(supersededId: string, replacementId: string): Promise<{ superseded: MemoryRecord; replacement: MemoryRecord }> {
    const relation = await this.memories.supersede(memoryIdSchema.parse(supersededId), memoryIdSchema.parse(replacementId));
    await this.indexMaintainer?.onSuperseded(relation);
    return relation;
  }

  async source(id: string): Promise<MemorySourceTrace> {
    const memoryId = memoryIdSchema.parse(id);
    const memory = await this.memories.get(memoryId);
    if (!memory) throw new MemoryNotFoundError(memoryId);
    const messages = await Promise.all(memory.sourceReferences.map(async (source) => {
      const message = await this.history.get(source.sessionId, source.messageId);
      if (!message) throw new MemorySourceNotFoundError(memory.id, source);
      return message;
    }));
    return { memory, messages };
  }

  private async assertSourcesExist(sources: readonly MemorySourceReference[], memoryId: string): Promise<void> {
    for (const source of sources) {
      if (!await this.history.get(source.sessionId, source.messageId)) {
        throw new MemorySourceNotFoundError(memoryId, source);
      }
    }
  }
}
