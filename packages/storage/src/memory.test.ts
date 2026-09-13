import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryService,
  MemorySourceNotFoundError,
  type MemoryCreateInput,
  type MemoryStore,
  type MemoryType,
} from "@mnemos/core";
import { SqliteHistoryStore } from "./sqlite.js";
import { SqliteMemoryStore } from "./memory.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function database(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), "mnemos-memory-"));
  return join(directory, "runtime.sqlite");
}

async function historySources(history: SqliteHistoryStore, sessionId = "session-a") {
  const user = await history.append({ sessionId, role: "user", content: "The project currently uses SQLite." });
  const assistant = await history.append({ sessionId, role: "assistant", content: "SQLite is the current persistence choice." });
  const tool = await history.append({ sessionId, role: "tool", content: "Database migration analysis complete." });
  return [user, assistant, tool];
}

function input(overrides: Partial<MemoryCreateInput> = {}): MemoryCreateInput {
  return {
    type: "decision",
    content: "Project uses SQLite for local persistence.",
    sourceReferences: [],
    importance: 0.8,
    confidence: 0.9,
    sourceType: "explicit_user_statement",
    status: "active",
    entities: ["database", "SQLite"],
    tags: ["architecture", "persistence"],
    ...overrides,
  };
}

describe("SqliteMemoryStore", () => {
  it("persists every Memory type, metadata, updates, and stable source references across restart", async () => {
    const path = await database();
    const history = new SqliteHistoryStore(path);
    const sources = await historySources(history);
    const sqliteMemoryStore = new SqliteMemoryStore(path);
    const memoryStore: MemoryStore = sqliteMemoryStore;
    const service = new MemoryService(memoryStore, history);
    const types: MemoryType[] = ["semantic", "episodic", "decision", "preference", "entity"];
    const records = [];
    for (const [index, type] of types.entries()) {
      records.push(await service.create(input({
        type,
        content: `${type} memory about SQLite`,
        sourceReferences: [{ sessionId: sources[0].sessionId, messageId: sources[index % sources.length].id }],
        importance: index / 10,
        confidence: 1 - index / 10,
        sourceType: index % 2 === 0 ? "explicit_user_statement" : "assistant_inference",
        lastConfirmedAt: "2026-01-02T00:00:00.000Z",
        entities: ["database", type],
        tags: ["phase-3"],
      })));
    }
    expect(records.map((record) => record.type)).toEqual(types);
    expect(records[2].sourceIds).toEqual([sources[2].id]);

    const updated = await service.update(records[2].id, {
      content: "Decision memory: SQLite remains the local persistence layer.",
      importance: 0.95,
      confidence: 0.85,
      entities: ["database", "sqlite", "local"],
      tags: ["architecture", "confirmed"],
      lastConfirmedAt: null,
    });
    expect(updated.lastConfirmedAt).toBeUndefined();
    expect(updated.importance).toBe(0.95);
    expect(updated.entities).toEqual(["database", "local", "sqlite"]);
    expect((await memoryStore.search({ query: "remains local" })).map((result) => result.memory.id)).toEqual([records[2].id]);
    expect((await memoryStore.getMany([records[4].id, records[0].id])).map((record) => record.id)).toEqual([records[4].id, records[0].id]);
    sqliteMemoryStore.close();

    const reopened = new SqliteMemoryStore(path);
    const restored = await reopened.get(records[2].id);
    expect(restored).toMatchObject({
      id: records[2].id,
      content: "Decision memory: SQLite remains the local persistence layer.",
      importance: 0.95,
      confidence: 0.85,
      sourceIds: [sources[2].id],
      tags: ["architecture", "confirmed"],
    });
    expect(await reopened.list()).toHaveLength(5);
    reopened.close();
    history.close();
  });

  it("uses FTS5 ranking and filters current facts by status, type, entity, and tag", async () => {
    const path = await database();
    const history = new SqliteHistoryStore(path);
    const [source] = await historySources(history);
    const memoryStore = new SqliteMemoryStore(path);
    const service = new MemoryService(memoryStore, history);
    const sqlite = await service.create(input({
      content: "Project uses SQLite database for local persistence.",
      sourceReferences: [{ sessionId: source.sessionId, messageId: source.id }],
      entities: ["database", "sqlite"],
      tags: ["architecture"],
    }));
    const postgres = await service.create(input({
      content: "Project uses PostgreSQL database for production persistence.",
      sourceReferences: [{ sessionId: source.sessionId, messageId: source.id }],
      entities: ["database", "postgresql"],
      tags: ["architecture", "production"],
    }));
    const rankingPeer = await service.create(input({
      type: "semantic",
      content: "The database selection affects backups and operational cost.",
      sourceReferences: [{ sessionId: source.sessionId, messageId: source.id }],
      entities: ["database"],
      tags: ["operations"],
    }));

    const ranked = await service.search({ query: "database", statuses: ["active"], limit: 10 });
    expect(ranked.map((result) => result.memory.id)).toEqual(expect.arrayContaining([sqlite.id, postgres.id, rankingPeer.id]));
    expect(ranked.every((result, index) => index === 0 || ranked[index - 1].score <= result.score)).toBe(true);
    expect((await service.search({ query: "PostgreSQL", types: ["decision"] })).map((result) => result.memory.id)).toEqual([postgres.id]);
    expect((await service.search({ query: "database", entities: ["postgresql"], tags: ["production"] })).map((result) => result.memory.id)).toEqual([postgres.id]);

    const relation = await memoryStore.supersede(sqlite.id, postgres.id);
    expect(relation.superseded).toMatchObject({ status: "superseded", supersededBy: postgres.id });
    expect((await service.search({ query: "SQLite" }))).toHaveLength(0);
    expect((await service.search({ query: "SQLite", statuses: ["superseded"] })).map((result) => result.memory.id)).toEqual([sqlite.id]);
    expect((await memoryStore.list({ statuses: ["active"] })).map((record) => record.id)).not.toContain(sqlite.id);
    memoryStore.close();
    history.close();
  });

  it("keeps supersede atomic and rejects self, missing, and invalid successor relationships", async () => {
    const path = await database();
    const history = new SqliteHistoryStore(path);
    const [source] = await historySources(history);
    const memoryStore = new SqliteMemoryStore(path);
    const service = new MemoryService(memoryStore, history);
    const first = await service.create(input({ sourceReferences: [{ sessionId: source.sessionId, messageId: source.id }] }));
    const archived = await service.create(input({
      content: "Archived alternative",
      sourceReferences: [{ sessionId: source.sessionId, messageId: source.id }],
      status: "archived",
    }));

    await expect(memoryStore.supersede(first.id, first.id)).rejects.toThrow(/itself/);
    await expect(memoryStore.supersede(first.id, "00000000-0000-4000-8000-000000000999")).rejects.toThrow(/not found/);
    await expect(memoryStore.supersede(first.id, archived.id)).rejects.toThrow(/active or provisional/);
    expect(await memoryStore.get(first.id)).toMatchObject({ status: "active" });
    expect(await memoryStore.get(archived.id)).toMatchObject({ status: "archived" });
    memoryStore.close();
    history.close();
  });

  it("traces multiple Memory sources to canonical History and rejects missing source references", async () => {
    const path = await database();
    const history = new SqliteHistoryStore(path);
    const sources = await historySources(history);
    const memoryStore = new SqliteMemoryStore(path);
    const service = new MemoryService(memoryStore, history);
    const memory = await service.create(input({
      content: "The project chose SQLite after user discussion and migration analysis.",
      sourceReferences: [
        { sessionId: sources[0].sessionId, messageId: sources[0].id },
        { sessionId: sources[2].sessionId, messageId: sources[2].id },
      ],
      entities: ["SQLite", "database"],
      tags: ["decision"],
    }));

    const found = await service.search({ query: "SQLite" });
    expect(found.map((result) => result.memory.id)).toContain(memory.id);
    const trace = await service.source(memory.id);
    expect(trace.messages.map((entry) => entry.id)).toEqual([sources[0].id, sources[2].id]);
    expect(trace.memory.sourceIds).toEqual([sources[0].id, sources[2].id]);

    await expect(service.create(input({
      content: "This memory has no valid source.",
      sourceReferences: [{ sessionId: "session-a", messageId: "00000000-0000-4000-8000-000000000999" }],
    }))).rejects.toBeInstanceOf(MemorySourceNotFoundError);
    expect(await memoryStore.list()).toHaveLength(1);

    const importedWithoutVerification = await memoryStore.create(input({
      content: "Imported legacy memory with unavailable canonical evidence.",
      sourceReferences: [{ sessionId: "session-a", messageId: "00000000-0000-4000-8000-000000000999" }],
    }));
    await expect(service.source(importedWithoutVerification.id)).rejects.toBeInstanceOf(MemorySourceNotFoundError);
    memoryStore.close();
    history.close();
  });

  it("returns an ordered entity timeline including superseded decision history", async () => {
    const path = await database();
    const history = new SqliteHistoryStore(path);
    const [source] = await historySources(history);
    const memoryStore = new SqliteMemoryStore(path);
    const service = new MemoryService(memoryStore, history);
    const sqlite = await service.create(input({
      content: "Database decision: SQLite.",
      sourceReferences: [{ sessionId: source.sessionId, messageId: source.id }],
      createdAt: "2026-01-01T00:00:00.000Z",
      entities: ["database"],
      tags: ["decision"],
    }));
    const postgres = await service.create(input({
      content: "Database decision: PostgreSQL.",
      sourceReferences: [{ sessionId: source.sessionId, messageId: source.id }],
      createdAt: "2026-02-01T00:00:00.000Z",
      entities: ["database"],
      tags: ["decision"],
    }));
    const redis = await service.create(input({
      content: "Database decision: PostgreSQL plus Redis.",
      sourceReferences: [{ sessionId: source.sessionId, messageId: source.id }],
      createdAt: "2026-03-01T00:00:00.000Z",
      entities: ["database"],
      tags: ["decision"],
    }));
    await memoryStore.supersede(sqlite.id, postgres.id);

    expect((await service.timeline({ entity: "DATABASE" })).map((record) => record.id)).toEqual([sqlite.id, postgres.id, redis.id]);
    expect((await service.timeline({ tag: "decision", statuses: ["active"] })).map((record) => record.id)).toEqual([postgres.id, redis.id]);
    memoryStore.close();
    history.close();
  });
});
