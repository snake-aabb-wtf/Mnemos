import { createHash } from "node:crypto";
import { z } from "zod";
import {
  memoryDurabilitySchema,
  memoryEntityRelationSchema,
  memoryIdSchema,
  memoryRecordSchema,
  memorySourceReferenceSchema,
  memorySourceTypeSchema,
  memoryTypeSchema,
  type MemoryDurability,
  type MemoryEntityRelation,
  type MemoryRecord,
  type MemoryScope,
  type MemoryService,
  type MemorySourceReference,
  type MemorySourceType,
  type MemoryType,
} from "./memory.js";
import type { EventBus, HarnessEventMap } from "./events.js";

const nonEmptyText = z.string().trim().min(1);

export interface MemoryDecayPolicy {
  halfLifeDays: Record<MemoryType, number>;
  staleAfterDays: Record<MemoryType, number>;
  durableMultiplier: Record<MemoryDurability, number>;
  staleMultiplier: number;
  supersededMultiplier: number;
  archivedMultiplier: number;
}

export const defaultMemoryDecayPolicy: MemoryDecayPolicy = {
  halfLifeDays: { semantic: 365, episodic: 45, decision: 540, preference: 365, entity: 270 },
  staleAfterDays: { semantic: 730, episodic: 120, decision: 900, preference: 730, entity: 540 },
  durableMultiplier: { durable: 1, normal: 0.9, ephemeral: 0.7 },
  staleMultiplier: 0.5,
  supersededMultiplier: 0.35,
  archivedMultiplier: 0.45,
};

export interface MemoryIntelligencePolicy extends MemoryDecayPolicy {
  reinforcementSaturation: number;
  maxConfidenceBySourceType: Record<MemorySourceType, number>;
  confidenceStepBySourceType: Record<MemorySourceType, number>;
  minimumAbstractionEvents: number;
  minimumAbstractionSpanDays: number;
  minimumAbstractionConfidence: number;
  minimumEvidenceDiversity: number;
  scanLimit: number;
}

export const defaultMemoryIntelligencePolicy: MemoryIntelligencePolicy = {
  ...defaultMemoryDecayPolicy,
  reinforcementSaturation: 12,
  maxConfidenceBySourceType: {
    explicit_user_statement: 0.98,
    tool_observation: 0.92,
    derived_summary: 0.86,
    assistant_inference: 0.5,
  },
  confidenceStepBySourceType: {
    explicit_user_statement: 0.16,
    tool_observation: 0.1,
    derived_summary: 0.07,
    assistant_inference: 0.03,
  },
  minimumAbstractionEvents: 3,
  minimumAbstractionSpanDays: 30,
  minimumAbstractionConfidence: 0.55,
  minimumEvidenceDiversity: 3,
  scanLimit: 20_000,
};

export const memoryIntelligencePolicySchema = z.object({
  halfLifeDays: z.record(memoryTypeSchema, z.number().positive()),
  staleAfterDays: z.record(memoryTypeSchema, z.number().positive()),
  durableMultiplier: z.record(memoryDurabilitySchema, z.number().positive()),
  staleMultiplier: z.number().min(0).max(1),
  supersededMultiplier: z.number().min(0).max(1),
  archivedMultiplier: z.number().min(0).max(1),
  reinforcementSaturation: z.number().int().positive(),
  maxConfidenceBySourceType: z.record(memorySourceTypeSchema, z.number().min(0).max(1)),
  confidenceStepBySourceType: z.record(memorySourceTypeSchema, z.number().positive().max(1)),
  minimumAbstractionEvents: z.number().int().positive(),
  minimumAbstractionSpanDays: z.number().nonnegative(),
  minimumAbstractionConfidence: z.number().min(0).max(1),
  minimumEvidenceDiversity: z.number().int().positive(),
  scanLimit: z.number().int().positive(),
}).strict();

export interface MemoryIntelligenceSignals {
  decay: number;
  reinforcement: number;
  stale: number;
  effectiveScore: number;
}

export function memoryIntelligenceSignals(
  memory: MemoryRecord,
  now: Date = new Date(),
  policy: MemoryDecayPolicy = defaultMemoryDecayPolicy,
): MemoryIntelligenceSignals {
  const reference = memory.lastConfirmedAt ?? memory.updatedAt;
  const ageDays = Math.max(0, now.getTime() - new Date(reference).getTime()) / 86_400_000;
  const halfLife = policy.halfLifeDays[memory.type];
  const decay = Math.exp(-Math.log(2) * ageDays / halfLife);
  const reinforcement = Math.min(1, Math.max(0, memory.reinforcementScore));
  const stale = memory.stale ? policy.staleMultiplier : 1;
  const status = memory.status === "superseded"
    ? policy.supersededMultiplier
    : memory.status === "archived" ? policy.archivedMultiplier : memory.status === "provisional" ? 0.85 : 1;
  const durability = policy.durableMultiplier[memory.durability];
  const effectiveScore = Math.max(0, Math.min(1,
    memory.importance
    * memory.confidence
    * (0.65 + 0.35 * reinforcement)
    * decay
    * stale
    * status
    * durability,
  ));
  return { decay, reinforcement, stale, effectiveScore };
}

export interface MemoryEntityGraphEntity {
  id: string;
  canonicalName: string;
  aliases: readonly string[];
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEntityGraphRelation {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  relation: MemoryEntityRelation["relation"];
  memoryIds: readonly string[];
  sourceReferences: readonly MemorySourceReference[];
  scope: MemoryScope;
  createdAt: string;
  updatedAt: string;
}

export interface EntityGraphStore {
  upsertMemory(memory: MemoryRecord): Promise<void>;
  listEntities(): Promise<readonly MemoryEntityGraphEntity[]>;
  listRelations(): Promise<readonly MemoryEntityGraphRelation[]>;
  clear(): Promise<void>;
}

export interface MemoryIntelligenceAuditEntry {
  id: string;
  operation: "reinforce" | "merge" | "abstract" | "mark_stale" | "confirm" | "supersede" | "graph_rebuild";
  memoryIds: readonly string[];
  sourceIds: readonly string[];
  reason?: string;
  policyVersion: string;
  createdAt: string;
}

export interface MemoryIntelligenceAuditStore {
  append(entry: MemoryIntelligenceAuditEntry): Promise<void>;
  list(): Promise<readonly MemoryIntelligenceAuditEntry[]>;
}

export class InMemoryMemoryIntelligenceAuditStore implements MemoryIntelligenceAuditStore {
  private readonly entries = new Map<string, MemoryIntelligenceAuditEntry>();

  async append(entry: MemoryIntelligenceAuditEntry): Promise<void> {
    this.entries.set(entry.id, entry);
  }

  async list(): Promise<readonly MemoryIntelligenceAuditEntry[]> {
    return [...this.entries.values()];
  }
}

export const memoryIntelligenceDecisionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("reinforce"),
    memoryId: memoryIdSchema,
    sourceReferences: z.array(memorySourceReferenceSchema).min(1),
    sourceType: memorySourceTypeSchema.optional(),
    reason: nonEmptyText.optional(),
  }).strict(),
  z.object({
    kind: z.literal("merge"),
    memoryIds: z.array(memoryIdSchema).min(2),
    content: nonEmptyText,
    type: memoryTypeSchema.optional(),
    reason: nonEmptyText.optional(),
  }).strict(),
  z.object({
    kind: z.literal("abstract"),
    memoryIds: z.array(memoryIdSchema).min(2),
    content: nonEmptyText,
    entities: z.array(nonEmptyText).default([]),
    tags: z.array(nonEmptyText).default([]),
    reason: nonEmptyText.optional(),
  }).strict(),
  z.object({
    kind: z.literal("mark_stale"),
    memoryId: memoryIdSchema,
    reason: nonEmptyText.optional(),
  }).strict(),
  z.object({
    kind: z.literal("supersede"),
    memoryId: memoryIdSchema,
    replacementId: memoryIdSchema,
    reason: nonEmptyText.optional(),
  }).strict(),
]);
export type MemoryIntelligenceDecision = z.infer<typeof memoryIntelligenceDecisionSchema>;

export const memoryIntelligenceProposalSchema = z.object({
  decisions: z.array(memoryIntelligenceDecisionSchema),
}).strict();
export type MemoryIntelligenceProposal = z.infer<typeof memoryIntelligenceProposalSchema>;

export interface MemoryReinforcementInput {
  memoryId: string;
  sourceReferences: readonly MemorySourceReference[];
  sourceType?: MemorySourceType;
  reason?: string;
}

export interface MemoryMergeInput {
  memoryIds: readonly string[];
  content: string;
  type?: MemoryType;
  reason?: string;
}

export interface MemoryAbstractionInput {
  memoryIds: readonly string[];
  content: string;
  entities?: readonly string[];
  tags?: readonly string[];
  reason?: string;
}

export interface MemorySupersedeInput {
  memoryId: string;
  replacementId: string;
  reason?: string;
}

export interface MemoryMaintenanceReport {
  scanned: number;
  staleMarked: number;
  abstractionsCreated: number;
  groupsConsidered: number;
  durationMs: number;
}

export interface MemoryIntelligenceServiceOptions {
  memories: MemoryService;
  graph?: EntityGraphStore;
  policy?: Partial<MemoryIntelligencePolicy>;
  now?: () => Date;
  events?: EventBus<HarnessEventMap>;
  audit?: MemoryIntelligenceAuditStore;
  policyVersion?: string;
}

export class MemoryIntelligenceService {
  readonly policy: MemoryIntelligencePolicy;
  readonly policyVersion: string;
  private readonly now: () => Date;
  private readonly audit: MemoryIntelligenceAuditStore;

  constructor(private readonly options: MemoryIntelligenceServiceOptions) {
    this.policy = mergePolicy(defaultMemoryIntelligencePolicy, options.policy);
    memoryIntelligencePolicySchema.parse(this.policy);
    this.policyVersion = options.policyVersion ?? "memory-intelligence/v1";
    this.now = options.now ?? (() => new Date());
    this.audit = options.audit ?? new InMemoryMemoryIntelligenceAuditStore();
  }

  score(memory: MemoryRecord, now = this.now()): MemoryIntelligenceSignals {
    return memoryIntelligenceSignals(memory, now, this.policy);
  }

  async reinforce(input: MemoryReinforcementInput): Promise<MemoryRecord> {
    const memory = await this.requireMutable(input.memoryId);
    const additions = uniqueSources(input.sourceReferences).filter((source) => !hasSource(memory.sourceReferences, source));
    if (additions.length === 0) return memory;
    const evidenceType = strongerSourceType(memory.sourceType, input.sourceType);
    const sourceCount = new Set([...memory.sourceReferences, ...additions].map(sourceKey)).size;
    const confirmationCount = Math.min(this.policy.reinforcementSaturation, Math.max(memory.confirmationCount, sourceCount));
    const reinforcementScore = Math.min(1, confirmationCount / this.policy.reinforcementSaturation);
    const confidence = evolveConfidence(memory.confidence, evidenceType, additions.length, this.policy);
    const confirmedAt = this.now().toISOString();
    const updated = await this.options.memories.update(memory.id, {
      sourceReferences: [...memory.sourceReferences, ...additions],
      lastConfirmedAt: confirmedAt,
      lastReinforcedAt: confirmedAt,
      confirmationCount,
      reinforcementScore,
      confidence,
      sourceType: evidenceType,
      stale: false,
      staleSince: null,
    });
    await this.syncGraph(updated);
    await this.record("reinforce", [updated.id], additions.map((source) => source.messageId), input.reason);
    await this.emit("memory.reinforced", {
      memoryId: updated.id,
      sourceIds: additions.map((source) => source.messageId),
      confirmationCount: updated.confirmationCount,
      confidence: updated.confidence,
      reinforcementScore: updated.reinforcementScore,
    });
    return updated;
  }

  async confirm(input: MemoryReinforcementInput): Promise<MemoryRecord> {
    return this.reinforce(input);
  }

  async supersede(input: MemorySupersedeInput): Promise<{ superseded: MemoryRecord; replacement: MemoryRecord }> {
    const superseded = await this.options.memories.get(input.memoryId);
    const replacement = await this.options.memories.get(input.replacementId);
    if (!superseded || !replacement) throw new Error("Memory supersede references a missing record");
    if (superseded.scope.kind !== replacement.scope.kind || superseded.scope.id !== replacement.scope.id) {
      throw new Error("Memory supersede requires matching scopes");
    }
    const relation = await this.options.memories.supersede(input.memoryId, input.replacementId);
    await this.record("supersede", [relation.superseded.id, relation.replacement.id], relation.replacement.sourceIds, input.reason);
    try {
      await this.options.events?.emit("memory.superseded", {
        jobId: intelligenceId("supersede", relation.superseded.id, relation.replacement.id),
        superseded: relation.superseded,
        replacement: relation.replacement,
      });
    } catch { /* observability cannot corrupt the canonical transition */ }
    return relation;
  }

  async markStale(memoryId: string, reason?: string): Promise<MemoryRecord> {
    const memory = await this.options.memories.get(memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);
    if (memory.stale) return memory;
    const staleSince = this.now().toISOString();
    const updated = await this.options.memories.update(memory.id, { stale: true, staleSince });
    await this.record("mark_stale", [updated.id], updated.sourceIds, reason);
    await this.emit("memory.marked_stale", { memoryId: updated.id, staleSince, reason });
    return updated;
  }

  async merge(input: MemoryMergeInput): Promise<{ merged: MemoryRecord; archived: readonly MemoryRecord[] }> {
    const ids = uniqueIds(input.memoryIds);
    if (ids.length < 2) throw new Error("Memory merge requires at least two distinct records");
    const mergeIds = [...ids].sort();
    const records = await this.options.memories.getMany(ids);
    if (records.length !== ids.length) throw new Error("Memory merge references a missing record");
    const first = records[0]!;
    if (records.some((record) => record.scope.kind !== first.scope.kind || record.scope.id !== first.scope.id)) {
      throw new Error("Memory merge requires matching scopes");
    }
    const targetId = intelligenceId("merge", mergeIds);
    const existingTarget = await this.options.memories.get(targetId);
    if (existingTarget) {
      if (existingTarget.status !== "active"
        || existingTarget.derivedFromMemoryIds.length !== ids.length
        || existingTarget.derivedFromMemoryIds.some((id) => !mergeIds.includes(id))
        || existingTarget.content !== input.content
        || existingTarget.type !== (input.type ?? first.type)) {
        throw new Error("Memory merge target already exists with incompatible provenance");
      }
      return { merged: existingTarget, archived: records.filter((record) => record.id !== existingTarget.id) };
    }
    if (records.some((record) => record.status === "superseded" || record.status === "archived")) {
      throw new Error("Memory merge requires active or provisional records");
    }
    if (records.some((record) => record.type !== (input.type ?? first.type))) {
      throw new Error("Memory merge requires compatible memory types");
    }
    const sources = uniqueSources(records.flatMap((record) => record.sourceReferences));
    const merged = await this.options.memories.create({
        id: targetId,
        type: input.type ?? first.type,
        content: input.content,
        sourceReferences: sources,
        createdAt: first.createdAt,
        lastConfirmedAt: this.now().toISOString(),
        importance: Math.max(...records.map((record) => record.importance)),
        confidence: Math.min(0.98, Math.max(...records.map((record) => record.confidence))),
        sourceType: "derived_summary",
        status: "active",
        derivedFromMemoryIds: mergeIds,
        confirmationCount: Math.min(this.policy.reinforcementSaturation, sources.length),
        reinforcementScore: Math.min(1, sources.length / this.policy.reinforcementSaturation),
        durability: strongestDurability(records.map((record) => record.durability)),
        scope: first.scope,
        entityRelations: uniqueRelations(records.flatMap((record) => record.entityRelations)),
        entities: uniqueText(records.flatMap((record) => record.entities)),
        tags: uniqueText(records.flatMap((record) => record.tags)),
    });
    const archived: MemoryRecord[] = [];
    for (const record of records) {
      if (record.status === "archived" && record.mergedInto === merged.id) continue;
      archived.push(await this.options.memories.update(record.id, { status: "archived", mergedInto: merged.id }));
    }
    await this.syncGraph(merged);
    await this.record("merge", [merged.id, ...mergeIds], sources.map((source) => source.messageId), input.reason);
    await this.emit("memory.merged", { memoryId: merged.id, mergedMemoryIds: mergeIds, sourceIds: sources.map((source) => source.messageId), reason: input.reason });
    return { merged, archived };
  }

  async abstract(input: MemoryAbstractionInput): Promise<MemoryRecord> {
    const ids = uniqueIds(input.memoryIds);
    if (ids.length < this.policy.minimumAbstractionEvents) {
      throw new Error(`Memory abstraction requires at least ${this.policy.minimumAbstractionEvents} supporting memories`);
    }
    const records = await this.options.memories.getMany(ids);
    if (records.length !== ids.length) throw new Error("Memory abstraction references a missing record");
    if (records.some((record) => record.type !== "episodic" && record.type !== "semantic")) {
      throw new Error("Memory abstraction requires episodic or semantic evidence");
    }
    if (records.some((record) => record.status !== "active" && record.status !== "provisional")) {
      throw new Error("Memory abstraction requires active or provisional evidence");
    }
    const first = records[0]!;
    if (records.some((record) => record.scope.kind !== first.scope.kind || record.scope.id !== first.scope.id)) {
      throw new Error("Memory abstraction requires matching scopes");
    }
    const spanDays = (Math.max(...records.map((record) => new Date(record.createdAt).getTime()))
      - Math.min(...records.map((record) => new Date(record.createdAt).getTime()))) / 86_400_000;
    const sources = uniqueSources(records.flatMap((record) => record.sourceReferences));
    if (spanDays < this.policy.minimumAbstractionSpanDays || sources.length < this.policy.minimumEvidenceDiversity) {
      throw new Error("Memory abstraction does not meet time-span or evidence-diversity thresholds");
    }
    if (Math.min(...records.map((record) => record.confidence)) < this.policy.minimumAbstractionConfidence) {
      throw new Error("Memory abstraction evidence confidence is below policy threshold");
    }
    const targetId = intelligenceId("abstract", [...ids].sort(), input.content);
    const existing = await this.options.memories.get(targetId);
    if (existing) return existing;
    const record = await this.options.memories.create({
      id: targetId,
      type: "semantic",
      content: input.content,
      sourceReferences: sources,
      createdAt: first.createdAt,
      lastConfirmedAt: this.now().toISOString(),
      importance: Math.max(...records.map((item) => item.importance)),
      confidence: Math.min(0.9, Math.min(...records.map((item) => item.confidence)) + 0.05),
      sourceType: "derived_summary",
      status: "active",
      derivedFromMemoryIds: ids,
      confirmationCount: Math.min(this.policy.reinforcementSaturation, sources.length),
      reinforcementScore: Math.min(1, sources.length / this.policy.reinforcementSaturation),
      durability: "durable",
      scope: first.scope,
      entities: uniqueText(input.entities ?? records.flatMap((item) => item.entities)),
      tags: uniqueText(input.tags ?? records.flatMap((item) => item.tags)),
      entityRelations: uniqueRelations(records.flatMap((item) => item.entityRelations)),
    });
    await this.syncGraph(record);
    await this.record("abstract", [record.id, ...ids], sources.map((source) => source.messageId), input.reason);
    await this.emit("memory.abstracted", { memoryId: record.id, derivedFromMemoryIds: ids, sourceIds: sources.map((source) => source.messageId), reason: input.reason });
    return record;
  }

  async applyProposal(raw: unknown): Promise<readonly unknown[]> {
    const proposal = memoryIntelligenceProposalSchema.parse(raw);
    const operations: unknown[] = [];
    for (const decision of proposal.decisions) {
      if (decision.kind === "reinforce") operations.push(await this.reinforce({
        memoryId: decision.memoryId,
        sourceReferences: decision.sourceReferences,
        sourceType: decision.sourceType,
        reason: decision.reason,
      }));
      else if (decision.kind === "merge") operations.push(await this.merge({
        memoryIds: decision.memoryIds,
        content: decision.content,
        type: decision.type,
        reason: decision.reason,
      }));
      else if (decision.kind === "abstract") operations.push(await this.abstract({
        memoryIds: decision.memoryIds,
        content: decision.content,
        entities: decision.entities,
        tags: decision.tags,
        reason: decision.reason,
      }));
      else if (decision.kind === "mark_stale") operations.push(await this.markStale(decision.memoryId, decision.reason));
      else operations.push(await this.supersede({ memoryId: decision.memoryId, replacementId: decision.replacementId, reason: decision.reason }));
    }
    return operations;
  }

  async runMaintenance(options: { limit?: number; enableAbstraction?: boolean } = {}): Promise<MemoryMaintenanceReport> {
    const started = this.now().getTime();
    const records = await this.options.memories.list({
      statuses: ["active", "provisional"],
      limit: Math.min(options.limit ?? this.policy.scanLimit, this.policy.scanLimit),
    });
    let staleMarked = 0;
    for (const record of records) {
      if (!record.stale && this.shouldBeStale(record, this.now())) {
        await this.markStale(record.id, "policy_age_threshold");
        staleMarked += 1;
      }
    }
    let abstractionsCreated = 0;
    const groups = this.groupRepeatedEvents(records.filter((record) => !record.stale && !this.shouldBeStale(record, this.now())));
    if (options.enableAbstraction !== false) {
      const semanticRecords = await this.options.memories.list({
        types: ["semantic"],
        statuses: ["active", "provisional"],
        limit: this.policy.scanLimit,
      });
      const existingAbstractionKeys = new Set(semanticRecords.map((record) => derivedIdsKey(record.derivedFromMemoryIds)));
      for (const group of groups.values()) {
        if (!this.meetsAbstractionThreshold(group)) continue;
        const abstractionKey = derivedIdsKey(group.map((record) => record.id));
        if (existingAbstractionKeys.has(abstractionKey)) continue;
        try {
          await this.abstract({
            memoryIds: group.map((record) => record.id),
            content: this.defaultAbstractionContent(group),
            entities: uniqueText(group.flatMap((record) => record.entities)),
            tags: ["derived-summary"],
            reason: "repeated_event_policy",
          });
          existingAbstractionKeys.add(abstractionKey);
          abstractionsCreated += 1;
        } catch {
          // A candidate that fails a deterministic invariant is simply not an abstraction.
        }
      }
    }
    return {
      scanned: records.length,
      staleMarked,
      abstractionsCreated,
      groupsConsidered: groups.size,
      durationMs: Math.max(0, this.now().getTime() - started),
    };
  }

  async rebuildEntityGraph(): Promise<number> {
    if (!this.options.graph) return 0;
    await this.options.graph.clear();
    const records = await this.options.memories.list({
      statuses: ["active", "provisional", "superseded", "archived"],
      limit: this.policy.scanLimit,
    });
    for (const record of records) await this.options.graph.upsertMemory(record);
    await this.record("graph_rebuild", records.map((record) => record.id), records.flatMap((record) => record.sourceIds), "rebuild_from_memory");
    return records.length;
  }

  private async syncGraph(memory: MemoryRecord): Promise<void> {
    const graph = this.options.graph;
    if (!graph) return;
    const beforeEntities = new Map((await graph.listEntities()).map((entity) => [entity.id, entity]));
    const beforeRelations = new Map((await graph.listRelations()).map((relation) => [relation.id, relation]));
    await graph.upsertMemory(memory);
    const afterEntities = await graph.listEntities();
    const afterRelations = await graph.listRelations();
    for (const entity of afterEntities) {
      if (!beforeEntities.has(entity.id)) {
        await this.emit("entity.created", { entityId: entity.id, canonicalName: entity.canonicalName });
      }
    }
    for (const relation of afterRelations) {
      if (!beforeRelations.has(relation.id)) {
        await this.emit("entity.related", {
          relationId: relation.id,
          fromEntityId: relation.fromEntityId,
          toEntityId: relation.toEntityId,
          relation: relation.relation,
          memoryIds: relation.memoryIds,
        });
      }
    }
  }

  private async requireMutable(id: string): Promise<MemoryRecord> {
    const memory = await this.options.memories.get(memoryIdSchema.parse(id));
    if (!memory) throw new Error(`Memory not found: ${id}`);
    if (memory.status !== "active" && memory.status !== "provisional") throw new Error(`Memory ${id} is not mutable`);
    return memory;
  }

  private shouldBeStale(memory: MemoryRecord, now: Date): boolean {
    const reference = memory.lastConfirmedAt ?? memory.updatedAt;
    const ageDays = Math.max(0, now.getTime() - new Date(reference).getTime()) / 86_400_000;
    return ageDays >= this.policy.staleAfterDays[memory.type];
  }

  private groupRepeatedEvents(records: readonly MemoryRecord[]): Map<string, MemoryRecord[]> {
    const groups = new Map<string, MemoryRecord[]>();
    for (const record of records) {
      if (record.type !== "episodic") continue;
      const key = `${scopeKey(record.scope)}|${normalizeContent(record.content)}|${uniqueText(record.entities).join(",")}`;
      const group = groups.get(key) ?? [];
      group.push(record);
      groups.set(key, group);
    }
    return groups;
  }

  private meetsAbstractionThreshold(group: readonly MemoryRecord[]): boolean {
    if (group.length < this.policy.minimumAbstractionEvents) return false;
    if (Math.min(...group.map((record) => record.confidence)) < this.policy.minimumAbstractionConfidence) return false;
    const sources = uniqueSources(group.flatMap((record) => record.sourceReferences));
    if (sources.length < this.policy.minimumEvidenceDiversity) return false;
    const spanDays = (Math.max(...group.map((record) => new Date(record.createdAt).getTime()))
      - Math.min(...group.map((record) => new Date(record.createdAt).getTime()))) / 86_400_000;
    return spanDays >= this.policy.minimumAbstractionSpanDays;
  }

  private defaultAbstractionContent(group: readonly MemoryRecord[]): string {
    const content = group[0]?.content.replace(/[.!?]+$/, "") ?? "Repeated project event";
    return `Long-term pattern: ${content}.`;
  }

  private async record(operation: MemoryIntelligenceAuditEntry["operation"], memoryIds: readonly string[], sourceIds: readonly string[], reason?: string): Promise<void> {
    await this.audit.append({ id: intelligenceId("audit", operation, memoryIds, sourceIds), operation, memoryIds, sourceIds, ...(reason === undefined ? {} : { reason }), policyVersion: this.policyVersion, createdAt: this.now().toISOString() });
  }

  private async emit<K extends keyof HarnessEventMap>(event: K, payload: HarnessEventMap[K]): Promise<void> {
    try { await this.options.events?.emit(event, payload); } catch { /* observability cannot corrupt derived state */ }
  }
}

function mergePolicy(base: MemoryIntelligencePolicy, override?: Partial<MemoryIntelligencePolicy>): MemoryIntelligencePolicy {
  return {
    ...base,
    ...override,
    halfLifeDays: { ...base.halfLifeDays, ...override?.halfLifeDays },
    staleAfterDays: { ...base.staleAfterDays, ...override?.staleAfterDays },
    durableMultiplier: { ...base.durableMultiplier, ...override?.durableMultiplier },
    maxConfidenceBySourceType: { ...base.maxConfidenceBySourceType, ...override?.maxConfidenceBySourceType },
    confidenceStepBySourceType: { ...base.confidenceStepBySourceType, ...override?.confidenceStepBySourceType },
  };
}

function evolveConfidence(current: number, sourceType: MemorySourceType, count: number, policy: MemoryIntelligencePolicy): number {
  const step = policy.confidenceStepBySourceType[sourceType];
  const target = current + (1 - current) * (1 - Math.exp(-step * count));
  return Math.min(policy.maxConfidenceBySourceType[sourceType], target);
}

function strongerSourceType(left: MemorySourceType, right?: MemorySourceType): MemorySourceType {
  if (!right) return left;
  const rank: Record<MemorySourceType, number> = { assistant_inference: 0, derived_summary: 1, tool_observation: 2, explicit_user_statement: 3 };
  return rank[right] > rank[left] ? right : left;
}

function sourceKey(source: MemorySourceReference): string {
  return `${source.sessionId}:${source.messageId}`;
}

function hasSource(sources: readonly MemorySourceReference[], source: MemorySourceReference): boolean {
  return sources.some((candidate) => sourceKey(candidate) === sourceKey(source));
}

function uniqueSources(sources: readonly MemorySourceReference[]): MemorySourceReference[] {
  const map = new Map<string, MemorySourceReference>();
  for (const source of sources) map.set(sourceKey(source), source);
  return [...map.values()];
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => memoryIdSchema.parse(id)))];
}

function derivedIdsKey(ids: readonly string[]): string {
  return [...ids].sort().join("|");
}

function uniqueText(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function uniqueRelations(values: readonly MemoryEntityRelation[]): MemoryEntityRelation[] {
  const map = new Map<string, MemoryEntityRelation>();
  for (const relation of values) {
    const parsed = memoryEntityRelationSchema.parse(relation);
    map.set(`${parsed.from.toLowerCase()}|${parsed.relation}|${parsed.to.toLowerCase()}`, parsed);
  }
  return [...map.values()];
}

function strongestDurability(values: readonly MemoryDurability[]): MemoryDurability {
  return [...values].sort((left, right) => ({ ephemeral: 0, normal: 1, durable: 2 }[right] - ({ ephemeral: 0, normal: 1, durable: 2 }[left])))[0] ?? "normal";
}

function normalizeContent(content: string): string {
  return content.toLocaleLowerCase().replace(/\b(again|still|currently|today|yesterday|last|this|the|a|an)\b/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function scopeKey(scope: MemoryScope): string {
  return `${scope.kind}:${scope.id}`;
}

export function intelligenceId(kind: string, ...parts: readonly unknown[]): string {
  const digest = createHash("sha256").update(JSON.stringify([kind, ...parts])).digest("hex").slice(0, 32);
  const bytes = Buffer.from(digest, "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Conservative deterministic identity; uncertain aliases remain distinct. */
export function canonicalizeEntityName(name: string): string {
  const normalized = name.trim().toLocaleLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ");
  const aliases: Record<string, string> = {
    postgres: "postgresql",
    "postgres db": "postgresql",
    ts: "typescript",
    node: "node.js",
    nodejs: "node.js",
    "node js": "node.js",
  };
  return aliases[normalized] ?? normalized;
}

export function entityIdForName(name: string): string {
  return intelligenceId("entity", canonicalizeEntityName(name));
}

export function parseMemoryRecord(value: unknown): MemoryRecord {
  return memoryRecordSchema.parse(value);
}
