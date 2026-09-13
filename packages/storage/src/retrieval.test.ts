import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeterministicMemoryReranker,
  HybridMemoryRetriever,
  MemoryConsolidationService,
  MemoryEmbeddingIndexer,
  MemoryService,
  evaluateRetrieval,
  phase5RetrievalEvaluationCases,
  type EmbeddingModelDescriptor,
  type EmbeddingProvider,
  type HiddenAgent,
  type HiddenMemoryCandidate,
  type MemoryCreateInput,
  type MemoryVectorRecord,
} from "@mnemos/core";
import { SqliteConsolidationJobStore } from "./consolidation.js";
import { SqliteMemoryStore } from "./memory.js";
import { SqliteHistoryStore } from "./sqlite.js";
import { SqliteMemoryVectorStore } from "./vector.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function database(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), "mnemos-retrieval-"));
  return join(directory, "runtime.sqlite");
}

class FixtureEmbeddingProvider implements EmbeddingProvider {
  readonly descriptor: EmbeddingModelDescriptor = { model: "fixture-semantic", version: "v1", dimensions: 4 };
  calls = 0;

  async embed(input: string): Promise<readonly number[]> {
    this.calls += 1;
    const value = input.toLocaleLowerCase();
    if (value.includes("postgresql") || value.includes("持久化") || value.includes("数据持久化") || value.includes("现在数据库")) return [1, 0, 0, 0];
    if (value.includes("sqlite") || value.includes("最开始")) return [0, 1, 0, 0];
    if (value.includes("cfg-9a")) return [0, 0, 1, 0];
    if (value.includes("dark mode")) return [0, 0, 0, 1];
    return [0, 0, 0, 0.25];
  }
}

async function runtime(path: string) {
  const history = new SqliteHistoryStore(path);
  const store = new SqliteMemoryStore(path);
  const vectors = new SqliteMemoryVectorStore(path);
  const reader = new MemoryService(store, history);
  const embeddings = new FixtureEmbeddingProvider();
  const indexer = new MemoryEmbeddingIndexer(embeddings, vectors, reader);
  const memories = new MemoryService(store, history, indexer);
  const retriever = new HybridMemoryRetriever({
    memories,
    embeddings,
    vectors,
    reranker: new DeterministicMemoryReranker({ now: () => new Date("2026-01-01T00:00:00.000Z") }),
  });
  return { history, store, vectors, embeddings, indexer, memories, retriever };
}

async function createMemory(
  app: Awaited<ReturnType<typeof runtime>>,
  key: string,
  content: string,
  overrides: Partial<MemoryCreateInput> = {},
) {
  const sessionId = overrides.sourceReferences?.[0]?.sessionId ?? "session-a";
  const source = await app.history.append({ sessionId, role: "user", content: `source:${key}` });
  return app.memories.create({
    type: "decision",
    content,
    sourceReferences: [{ sessionId, messageId: source.id }],
    createdAt: "2025-06-01T00:00:00.000Z",
    importance: 0.8,
    confidence: 0.9,
    sourceType: "explicit_user_statement",
    status: "active",
    entities: ["database"],
    tags: ["architecture"],
    ...overrides,
  });
}

function candidate(sessionId: string, messageId: string, content: string): HiddenMemoryCandidate {
  return {
    content,
    type: "decision",
    importance: 0.8,
    confidence: 0.9,
    sourceType: "explicit_user_statement",
    sourceReferences: [{ sessionId, messageId }],
    entities: ["database"],
    tags: ["architecture"],
    retrievalQuery: "项目的数据持久化最终选了什么？",
    status: "active",
  };
}

function eviction(sessionId: string, messageId: string) {
  return {
    compactionId: randomUUID(),
    sessionId,
    evictedMessages: [],
    evictedMessageIds: [messageId],
    sourceRange: { firstMessageId: messageId, lastMessageId: messageId, messageCount: 1 },
    retainedFromMessageId: randomUUID(),
    cutoff: {
      kind: "turn" as const,
      targetRetainedTokens: 1,
      actualRetainedTokens: 1,
      searchWindowTokens: 1,
      cutoffAfterMessageId: messageId,
      cutoffBeforeMessageId: randomUUID(),
    },
    pinnedContext: { id: "automatic-compaction", sessionId, source: "automatic" as const, content: "" },
  };
}

describe("Phase 5 hybrid Memory retrieval", () => {
  it("recovers a derived index after an embedding failure without losing canonical Memory", async () => {
    const path = await database();
    const app = await runtime(path);
    const embed = app.embeddings.embed.bind(app.embeddings);
    let failOnce = true;
    app.embeddings.embed = async (input: string) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("embedding provider temporarily unavailable");
      }
      return embed(input);
    };
    await expect(createMemory(app, "recovery", "Mnemos uses PostgreSQL as its primary database.")).rejects.toThrow("temporarily unavailable");
    const [canonical] = await app.memories.list();
    expect(canonical?.content).toContain("PostgreSQL");
    await app.memories.refreshIndexes(canonical.id);
    expect(await app.vectors.get(canonical.id)).toBeDefined();
    app.vectors.close(); app.store.close(); app.history.close();
  });

  it("creates, refreshes, preserves, supersedes, clears, and rebuilds derived embeddings", async () => {
    const path = await database();
    const app = await runtime(path);
    const sqlite = await createMemory(app, "sqlite", "Mnemos uses SQLite as its database.");
    expect(await app.vectors.get(sqlite.id)).toMatchObject({ status: "active", model: "fixture-semantic" });
    expect(app.embeddings.calls).toBe(1);

    await app.memories.update(sqlite.id, { tags: ["architecture", "local"] });
    expect(app.embeddings.calls).toBe(1);
    await app.memories.update(sqlite.id, { content: "Mnemos used SQLite as its database." });
    expect(app.embeddings.calls).toBe(2);

    const postgres = await createMemory(app, "postgres", "Mnemos uses PostgreSQL as its primary database.");
    expect(app.embeddings.calls).toBe(3);
    await app.memories.supersede(sqlite.id, postgres.id);
    expect(await app.vectors.get(sqlite.id)).toMatchObject({ status: "superseded" });
    expect(await app.vectors.get(postgres.id)).toMatchObject({ status: "active" });
    expect(app.embeddings.calls).toBe(3);

    await app.vectors.clear();
    expect(await app.retriever.retrieve({ query: "项目的数据持久化最终选了什么？" })).toEqual([]);
    expect(await app.indexer.rebuild()).toBe(2);
    expect((await app.retriever.retrieve({ query: "项目的数据持久化最终选了什么？" }))[0].memory.id).toBe(postgres.id);
    const currentVector = await app.vectors.get(postgres.id);
    if (!currentVector) throw new Error("Expected PostgreSQL vector");
    await app.vectors.upsert({ ...currentVector, values: [0, 1, 0, 0] });
    expect((await app.vectors.get(postgres.id))?.values).toEqual([0, 1, 0, 0]);
    await app.indexer.rebuild();
    expect((await app.vectors.get(postgres.id))?.values).toEqual([1, 0, 0, 0]);
    expect(await app.vectors.count()).toBe(2);
    app.vectors.close(); app.store.close(); app.history.close();
  });

  it("combines lexical, semantic, entity, metadata, temporal, and confidence signals with explainable RRF results", async () => {
    const path = await database();
    const app = await runtime(path);
    const sqlite = await createMemory(app, "sqlite-history", "Mnemos uses SQLite as the database.", {
      createdAt: "2024-01-01T00:00:00.000Z",
      entities: ["database", "sqlite"],
    });
    const postgres = await createMemory(app, "postgres-current", "Mnemos uses PostgreSQL as the primary database.", {
      createdAt: "2025-12-01T00:00:00.000Z",
      entities: ["database", "postgresql"],
      tags: ["architecture", "production"],
    });
    await app.memories.supersede(sqlite.id, postgres.id);
    const lowConfidence = await createMemory(app, "low-confidence", "Maybe SQLite is the persistence plan.", {
      sourceType: "assistant_inference",
      confidence: 0.3,
      entities: ["database"],
    });
    const symbol = await createMemory(app, "config-symbol", "Deployment parameter CFG-9A controls cache invalidation.", {
      type: "semantic",
      entities: ["configuration"],
      tags: ["ops"],
    });
    const otherSession = await createMemory(app, "other-session", "Other session uses PostgreSQL for analytics.", {
      sourceReferences: [{ sessionId: "session-b", messageId: (await app.history.append({ sessionId: "session-b", role: "user", content: "source:other" })).id }],
      entities: ["analytics"],
    });

    const exact = await app.retriever.retrieve({ query: "PostgreSQL" });
    expect(exact[0]).toMatchObject({ memory: { id: postgres.id }, matchedBy: expect.arrayContaining(["lexical", "semantic"]) });
    expect(exact[0].signals).toMatchObject({ lexical: expect.any(Number), semantic: expect.any(Number), recency: expect.any(Number) });
    const semantic = await app.retriever.retrieve({ query: "项目的数据持久化最终选了什么？" });
    expect(semantic[0]).toMatchObject({ memory: { id: postgres.id }, matchedBy: expect.arrayContaining(["semantic", "temporal"]) });
    const lexicalOnly = await app.retriever.retrieve({ query: "CFG-9A" });
    expect(lexicalOnly[0]).toMatchObject({ memory: { id: symbol.id }, matchedBy: expect.arrayContaining(["lexical"]) });
    const entity = await app.retriever.retrieve({ query: "database", entities: ["postgresql"] });
    expect(entity[0]).toMatchObject({ memory: { id: postgres.id }, matchedBy: expect.arrayContaining(["entity", "metadata"]) });
    const scoped = await app.retriever.retrieve({ query: "PostgreSQL", sessionId: "session-a" });
    expect(scoped.map((result) => result.memory.id)).not.toContain(otherSession.id);
    const metadata = await app.retriever.retrieve({
      query: "PostgreSQL",
      types: ["decision"],
      sourceTypes: ["explicit_user_statement"],
      tags: ["production"],
      after: "2025-01-01T00:00:00.000Z",
    });
    expect(metadata.map((result) => result.memory.id)).toEqual([postgres.id]);
    expect(await app.retriever.retrieve({ query: "PostgreSQL", before: "2025-01-01T00:00:00.000Z", entities: ["postgresql"] })).toHaveLength(0);
    expect((await app.retriever.retrieve({ query: "PostgreSQL", minimumConfidence: 0.8 }))[0].memory.id).toBe(postgres.id);
    expect((await app.retriever.retrieve({ query: "项目的数据持久化最终选了什么？", minimumConfidence: 0.8 })).map((result) => result.memory.id)).not.toContain(lowConfidence.id);
    const history = await app.retriever.retrieve({ query: "之前最开始用什么数据库？", statuses: ["superseded"] });
    expect(history[0].memory.id).toBe(sqlite.id);
    app.vectors.close(); app.store.close(); app.history.close();
  });

  it("uses HybridMemoryRetriever in Phase 4 consolidation without changing Hidden Agent contracts", async () => {
    const path = await database();
    const app = await runtime(path);
    const existing = await createMemory(app, "postgres-current", "Mnemos uses PostgreSQL as the primary database.", {
      entities: ["database", "postgresql"],
    });
    const source = await app.history.append({ sessionId: "session-a", role: "user", content: "PostgreSQL remains the selected persistence system." });
    const proposal = candidate("session-a", source.id, existing.content);
    const hidden: HiddenAgent = {
      async extract() { return { candidates: [proposal] }; },
      async reconcile(request) {
        expect(request.candidates[0].relatedMemories.map((memory) => memory.id)).toContain(existing.id);
        return { decisions: [{ kind: "duplicate", existingMemoryId: existing.id, sourceReferences: proposal.sourceReferences }] };
      },
    };
    const jobs = new SqliteConsolidationJobStore(path);
    const consolidation = new MemoryConsolidationService({ history: app.history, memories: app.memories, jobs, hiddenAgent: hidden, retriever: app.retriever });
    const queued = await jobs.enqueue(eviction("session-a", source.id));
    await consolidation.processNext();
    const updated = await app.memories.get(existing.id);
    expect(updated?.sourceReferences.map((reference) => reference.messageId)).toContain(source.id);
    expect((await jobs.get(queued.job.id))?.status).toBe("completed");
    jobs.close(); app.vectors.close(); app.store.close(); app.history.close();
  });

  it("evaluates the fixed retrieval dataset with Recall@K, Hit@K, and MRR", async () => {
    const path = await database();
    const app = await runtime(path);
    const keys = new Map<string, string>();
    const add = async (key: string, content: string, overrides: Partial<MemoryCreateInput> = {}) => {
      const record = await createMemory(app, key, content, overrides);
      keys.set(record.id, key);
      return record;
    };
    const sqlite = await add("sqlite-history", "Mnemos originally used SQLite as its database.", { entities: ["database", "sqlite"] });
    const postgres = await add("postgres-current", "Mnemos uses PostgreSQL as its primary database.", { entities: ["database", "postgresql"] });
    await app.memories.supersede(sqlite.id, postgres.id);
    await add("config-symbol", "Deployment parameter CFG-9A controls cache invalidation.", { type: "semantic", entities: ["configuration"] });
    await add("inference", "Maybe SQLite is the persistence plan.", { sourceType: "assistant_inference", confidence: 0.2, entities: ["database"] });
    const results = new Map();
    for (const fixture of phase5RetrievalEvaluationCases) {
      results.set(fixture.id, await app.retriever.retrieve({ query: fixture.query, ...fixture.options, limit: 3 }));
    }
    const metrics = evaluateRetrieval(phase5RetrievalEvaluationCases, results, (id) => keys.get(id), 3);
    expect(metrics).toMatchObject({ recallAtK: 1, hitAtK: 1, meanReciprocalRank: 1 });
    app.vectors.close(); app.store.close(); app.history.close();
  });

  it("searches a 10k derived-vector fixture without hydrating every canonical Memory record", async () => {
    const path = await database();
    const vectors = new SqliteMemoryVectorStore(path);
    const now = "2026-01-01T00:00:00.000Z";
    const rows: MemoryVectorRecord[] = Array.from({ length: 10_000 }, (_, index) => ({
      memoryId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      values: index === 9_999 ? [1, 0] : [0, 1],
      dimensions: 2,
      model: "load-test",
      modelVersion: "v1",
      contentHash: createHash("sha256").update(String(index)).digest("hex"),
      type: "semantic",
      status: "active",
      sourceType: "explicit_user_statement",
      confidence: 0.8,
      createdAt: now,
      updatedAt: now,
      entities: ["load"],
      tags: ["performance"],
      sessionIds: ["session-a"],
      indexedAt: now,
    }));
    await vectors.replaceAll(rows);
    const result = await vectors.search({ values: [1, 0], descriptor: { model: "load-test", version: "v1", dimensions: 2 }, limit: 3 });
    expect(result[0]?.memoryId).toBe(rows.at(-1)?.memoryId);
    expect(await vectors.count()).toBe(10_000);
    vectors.close();
  });
});
