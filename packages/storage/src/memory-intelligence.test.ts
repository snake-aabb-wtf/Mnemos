import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EventBus,
  MemoryIntelligenceService,
  MemoryService,
  type MemoryCreateInput,
  type MemoryRecord,
  type MemorySourceReference,
} from "@mnemos/core";
import { SqliteEntityGraphStore } from "./entity.js";
import { SqliteMemoryIntelligenceAuditStore } from "./intelligence.js";
import { SqliteHistoryStore } from "./sqlite.js";
import { SqliteMemoryStore } from "./memory.js";

let directory: string | undefined;
const openStores: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function fixture(): Promise<{ path: string; history: SqliteHistoryStore; memories: SqliteMemoryStore; service: MemoryService }> {
  directory = await mkdtemp(join(tmpdir(), "mnemos-memory-intelligence-"));
  const path = join(directory, "runtime.sqlite");
  const history = new SqliteHistoryStore(path);
  const memories = new SqliteMemoryStore(path);
  openStores.push(history, memories);
  return { path, history, memories, service: new MemoryService(memories, history) };
}

async function sources(history: SqliteHistoryStore, count: number, sessionId = "session-a"): Promise<MemorySourceReference[]> {
  const result: MemorySourceReference[] = [];
  for (let index = 0; index < count; index += 1) {
    const message = await history.append({
      sessionId,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Evidence ${index} for the project memory.`,
      createdAt: new Date(Date.UTC(2026, index, 1)).toISOString(),
    });
    result.push({ sessionId, messageId: message.id });
  }
  return result;
}

function input(sourceReferences: readonly MemorySourceReference[], overrides: Partial<MemoryCreateInput> = {}): MemoryCreateInput {
  return {
    type: "semantic",
    content: "Mnemos uses TypeScript.",
    sourceReferences: [...sourceReferences],
    createdAt: "2026-01-01T00:00:00.000Z",
    importance: 0.8,
    confidence: 0.55,
    sourceType: "explicit_user_statement",
    status: "active",
    ...overrides,
  };
}

describe("MemoryIntelligenceService", () => {
  it("reinforces only independent evidence and caps confidence", async () => {
    const { path, history, service } = await fixture();
    const [a, b, c, d] = await sources(history, 4);
    const memory = await service.create(input([a], {
      sourceType: "assistant_inference",
      confidence: 0.2,
      type: "semantic",
    }));
    const events = new EventBus();
    const audit = new SqliteMemoryIntelligenceAuditStore(path);
    openStores.push(audit);
    const reinforced: unknown[] = [];
    events.on("memory.reinforced", (event) => { reinforced.push(event); });
    const intelligence = new MemoryIntelligenceService({ memories: service, events, audit });

    const first = await intelligence.reinforce({ memoryId: memory.id, sourceReferences: [a, b], sourceType: "assistant_inference" });
    const retry = await intelligence.reinforce({ memoryId: memory.id, sourceReferences: [b], sourceType: "assistant_inference" });
    expect(retry.confirmationCount).toBe(first.confirmationCount);
    expect(first.confirmationCount).toBe(2);
    expect(first.sourceReferences).toHaveLength(2);
    expect(first.confidence).toBeLessThanOrEqual(0.5);
    expect(reinforced).toHaveLength(1);

    const explicit = await intelligence.reinforce({ memoryId: memory.id, sourceReferences: [c, d], sourceType: "explicit_user_statement" });
    expect(explicit.sourceReferences).toHaveLength(4);
    expect(explicit.confidence).toBeGreaterThan(first.confidence);
    expect(explicit.confidence).toBeLessThanOrEqual(0.98);
    expect((await intelligence.reinforce({ memoryId: memory.id, sourceReferences: [c, d] })).confirmationCount).toBe(4);
    expect((await audit.list()).map((entry) => entry.operation)).toEqual(["reinforce", "reinforce"]);
    const reopened = new SqliteMemoryStore(path);
    openStores.push(reopened);
    expect(await reopened.get(memory.id)).toMatchObject({ confirmationCount: 4, reinforcementScore: 4 / 12, sourceType: "explicit_user_statement" });
  });

  it("recomputes type-aware decay, marks stale records, and preserves historical retrieval", async () => {
    const { history, service } = await fixture();
    const [source, confirmation] = await sources(history, 2);
    let now = new Date("2026-06-01T00:00:00.000Z");
    const intelligence = new MemoryIntelligenceService({
      memories: service,
      now: () => now,
      policy: { staleAfterDays: { semantic: 90, episodic: 30, decision: 900, preference: 730, entity: 540 } },
    });
    const episodic = await service.create(input([source], {
      id: undefined,
      type: "episodic",
      content: "Debugged the PostgreSQL migration.",
      sourceType: "tool_observation",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastConfirmedAt: "2026-01-01T00:00:00.000Z",
      confidence: 0.8,
    }));
    const decision = await service.create(input([source], {
      type: "decision",
      content: "The project database decision is durable.",
      createdAt: "2024-01-01T00:00:00.000Z",
      lastConfirmedAt: "2024-01-01T00:00:00.000Z",
      durability: "durable",
    }));
    expect(intelligence.score(episodic).decay).toBeLessThan(intelligence.score(decision).decay);
    const report = await intelligence.runMaintenance({ enableAbstraction: false });
    expect(report.staleMarked).toBe(1);
    expect(await service.get(episodic.id)).toMatchObject({ stale: true });
    expect(await service.get(decision.id)).toMatchObject({ stale: false });
    expect((await service.search({ query: "PostgreSQL", statuses: ["active"] })).map((item) => item.memory.id)).toContain(episodic.id);
    now = new Date("2026-06-02T00:00:00.000Z");
    const refreshed = await intelligence.reinforce({ memoryId: episodic.id, sourceReferences: [confirmation], sourceType: "tool_observation" });
    expect(refreshed.stale).toBe(false);
  });

  it("merges compatible memories without losing provenance and keeps supersede distinct", async () => {
    const { history, service } = await fixture();
    const [a, b, c] = await sources(history, 3);
    const left = await service.create(input([a], { content: "Mnemos uses TypeScript." }));
    const right = await service.create(input([b], { content: "The Mnemos runtime is written in TypeScript." }));
    const intelligence = new MemoryIntelligenceService({ memories: service });
    const merged = await intelligence.merge({ memoryIds: [left.id, right.id], content: "Mnemos uses TypeScript as its runtime language." });
    expect(merged.merged.status).toBe("active");
    expect(merged.merged.sourceIds).toEqual(expect.arrayContaining([a.messageId, b.messageId]));
    expect(merged.merged.derivedFromMemoryIds).toEqual(expect.arrayContaining([left.id, right.id]));
    expect((await service.get(left.id))?.mergedInto).toBe(merged.merged.id);
    expect((await service.get(right.id))?.status).toBe("archived");
    expect((await service.source(merged.merged.id)).messages).toHaveLength(2);

    const sqlite = await service.create(input([c], { type: "decision", content: "The project uses SQLite." }));
    const postgres = await service.create(input([c], { type: "decision", content: "The project now uses PostgreSQL." }));
    const relation = await intelligence.supersede({ memoryId: sqlite.id, replacementId: postgres.id, reason: "explicit database change" });
    expect(relation.superseded.status).toBe("superseded");
    await expect(intelligence.merge({ memoryIds: [sqlite.id, postgres.id], content: "SQLite and PostgreSQL" })).rejects.toThrow(/active or provisional/);

    const oldPreference = await service.create(input([a], { type: "preference", content: "User prefers concise answers." }));
    const newPreference = await service.create(input([b], { type: "preference", content: "User now prefers detailed answers." }));
    const preferenceChange = await intelligence.supersede({ memoryId: oldPreference.id, replacementId: newPreference.id, reason: "preference change" });
    expect(preferenceChange.superseded.status).toBe("superseded");
    expect(preferenceChange.replacement.status).toBe("active");
  });

  it("creates idempotent repeated-event abstractions with source and derived provenance", async () => {
    const { history, service } = await fixture();
    const evidence = await sources(history, 3);
    const intelligence = new MemoryIntelligenceService({
      memories: service,
      now: () => new Date("2026-06-01T00:00:00.000Z"),
      policy: { minimumAbstractionSpanDays: 30, staleAfterDays: { semantic: 10_000, episodic: 10_000, decision: 10_000, preference: 10_000, entity: 10_000 } },
    });
    const records: MemoryRecord[] = [];
    for (const [index, source] of evidence.entries()) {
      records.push(await service.create(input([source], {
        type: "episodic",
        content: "Worked on the TypeScript Mnemos runtime.",
        sourceType: "tool_observation",
        createdAt: new Date(Date.UTC(2026, index * 2, 1)).toISOString(),
        lastConfirmedAt: new Date(Date.UTC(2026, index * 2, 1)).toISOString(),
      })));
    }
    const firstMaintenance = await intelligence.runMaintenance();
    expect(firstMaintenance.abstractionsCreated).toBe(1);
    const abstraction = (await service.list({ types: ["semantic"] }))[0]!;
    const retry = await intelligence.abstract({
      memoryIds: records.map((record) => record.id),
      content: "Long-term pattern: Worked on the TypeScript Mnemos runtime.",
    });
    expect((await intelligence.runMaintenance()).abstractionsCreated).toBe(0);
    expect(retry.id).toBe(abstraction.id);
    expect(abstraction.type).toBe("semantic");
    expect(abstraction.sourceReferences).toHaveLength(3);
    expect(abstraction.derivedFromMemoryIds).toEqual(records.map((record) => record.id));
    expect(await service.list({ types: ["episodic"] })).toHaveLength(3);
  });

  it("isolates scopes and rebuilds a lightweight entity graph with aliases", async () => {
    const { path, history, service } = await fixture();
    const [a, b] = await sources(history, 2);
    const graph = new SqliteEntityGraphStore(path);
    openStores.push(graph);
    const events = new EventBus();
    const created: string[] = [];
    const related: string[] = [];
    events.on("entity.created", (event) => { created.push(event.canonicalName); });
    events.on("entity.related", (event) => { related.push(event.relation); });
    const intelligence = new MemoryIntelligenceService({ memories: service, graph, events });
    const memory = await service.create(input([a], {
      entities: ["Mnemos", "Postgres", "Node.js"],
      entityRelations: [
        { from: "Mnemos", relation: "uses", to: "Postgres" },
        { from: "Mnemos", relation: "runs_on", to: "Node.js" },
      ],
    }));
    await intelligence.reinforce({ memoryId: memory.id, sourceReferences: [b] });
    expect((await graph.listEntities()).map((entity) => entity.canonicalName)).toEqual(expect.arrayContaining(["mnemos", "postgresql", "node.js"]));
    expect((await graph.listEntities()).find((entity) => entity.canonicalName === "postgresql")?.aliases).toEqual(expect.arrayContaining(["Postgres"]));
    expect((await graph.listRelations())).toHaveLength(2);
    expect(created).toEqual(expect.arrayContaining(["mnemos", "postgresql", "node.js"]));
    expect(related).toEqual(expect.arrayContaining(["uses", "runs_on"]));
    const before = await graph.listRelations();
    await graph.clear();
    await intelligence.rebuildEntityGraph();
    expect((await graph.listRelations()).map(({ id, fromEntityId, toEntityId, relation, memoryIds, sourceReferences, scope }) => ({ id, fromEntityId, toEntityId, relation, memoryIds, sourceReferences, scope })))
      .toEqual(before.map(({ id, fromEntityId, toEntityId, relation, memoryIds, sourceReferences, scope }) => ({ id, fromEntityId, toEntityId, relation, memoryIds, sourceReferences, scope })));

    const otherProject = await service.create(input([a], {
      scope: { kind: "project", id: "project-b" },
      content: "Mnemos uses SQLite.",
    }));
    const projectA = await service.create(input([b], {
      scope: { kind: "project", id: "project-a" },
      content: "Mnemos uses PostgreSQL.",
    }));
    await expect(intelligence.merge({ memoryIds: [otherProject.id, projectA.id], content: "same" })).rejects.toThrow(/matching scopes/);
    await expect(intelligence.supersede({ memoryId: otherProject.id, replacementId: projectA.id })).rejects.toThrow(/matching scopes/);
    expect((await service.list({ scopeKind: "project", scopeId: "project-a" })).map((item) => item.id)).toEqual([projectA.id]);
  });
});
