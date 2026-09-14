import { mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CompactionService,
  ContextManager,
  DeterministicCompactionSummarizer,
  EventBus,
  InMemoryContextCompactionStore,
  MemoryService,
  assertReliabilityInvariants,
  normalizedRuntimeSnapshot,
  SyntheticConversationGenerator,
  type ContextEviction,
} from "@mnemos/core";
import { SqliteArtifactStore } from "./artifact.js";
import { SqliteConsolidationJobStore } from "./consolidation.js";
import { SqliteMemoryStore } from "./memory.js";
import { SqliteHistoryStore } from "./sqlite.js";

const directories: string[] = [];
const closers: Array<() => void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function database(prefix = "mnemos-reliability-"): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return { directory, path: join(directory, "runtime.sqlite") };
}

function historyMessages(seed: string, sessionId: string, turns: number) {
  return new SyntheticConversationGenerator({ seed, sessionId, needleTurns: [83, Math.min(turns, 581)] }).generate(turns).messages;
}

function compactionContext(): ContextManager {
  return new ContextManager(undefined, {
    contextLimit: 2_000,
    generationReserveTokens: 200,
    recentRawTokenBudget: 400,
    pinnedTokenBudget: 300,
    agentPinnedTokenBudget: 100,
    retrievedMemoryTokenBudget: 100,
    toolSchemaTokenBudget: 100,
    toolResultTokenBudget: 100,
    highPressureThreshold: 0.75,
    compactionPressureThreshold: 0.85,
    emergencyPressureThreshold: 0.92,
  });
}

describe("Phase 12 persistence and recovery campaigns", () => {
  it("runs a 1k-turn compaction campaign without losing canonical History", async () => {
    const { path } = await database();
    const sessionId = "long-session";
    const history = new SqliteHistoryStore(path);
    const checkpoints = new InMemoryContextCompactionStore();
    const context = compactionContext();
    const service = new CompactionService({ history, checkpoints, context, summarizer: new DeterministicCompactionSummarizer() });
    closers.push(() => history.close());
    const messages = historyMessages("campaign", sessionId, 1_000);
    for (const message of messages) await history.append(message);

    const evicted = new Set<string>();
    const sourceRanges: number[] = [];
    const contexts = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const result = await service.prepare(sessionId);
      contexts.push(result.context);
      for (const event of result.evictions) {
        for (const id of event.evictedMessageIds) {
          expect(evicted.has(id)).toBe(false);
          evicted.add(id);
        }
        sourceRanges.push(event.sourceRange.messageCount);
      }
      if (result.evictions.length === 0) break;
    }

    expect((await history.list(sessionId))).toHaveLength(messages.length);
    expect(evicted.size).toBeGreaterThan(0);
    expect(sourceRanges.every((value, index) => index === 0 || value > sourceRanges[index - 1]!)).toBe(true);
    expect(contexts.every((built) => built.stats.recentRawTokens <= 400)).toBe(true);
    await assertReliabilityInvariants({ sessionId, history, contexts });
  });

  it("replays deterministic compaction to equivalent semantic boundaries", async () => {
    const { path } = await database();
    const sessionId = "replay-session";
    const history = new SqliteHistoryStore(path);
    closers.push(() => history.close());
    for (const message of historyMessages("replay", sessionId, 220)) await history.append(message);
    const firstContext = compactionContext();
    const secondContext = compactionContext();
    const first = await new CompactionService({ history, checkpoints: new InMemoryContextCompactionStore(), context: firstContext }).prepare(sessionId);
    const second = await new CompactionService({ history, checkpoints: new InMemoryContextCompactionStore(), context: secondContext }).prepare(sessionId);
    expect(first.context.recentMessages.map((message) => message.id)).toEqual(second.context.recentMessages.map((message) => message.id));
    expect(first.context.pinned.map((pin) => ({ content: pin.content, sourceRange: pin.sourceRange }))).toEqual(
      second.context.pinned.map((pin) => ({ content: pin.content, sourceRange: pin.sourceRange })),
    );
    expect(first.evictions.map((event) => ({ sourceRange: event.sourceRange, cutoff: event.cutoff }))).toEqual(
      second.evictions.map((event) => ({ sourceRange: event.sourceRange, cutoff: event.cutoff })),
    );
  });

  it("survives SQLite restart for History and Memory and preserves normalized state", async () => {
    const { path } = await database();
    const sessionId = "restart-session";
    const firstHistory = new SqliteHistoryStore(path);
    const firstStore = new SqliteMemoryStore(path);
    const firstMemory = new MemoryService(firstStore, firstHistory);
    closers.push(() => firstHistory.close(), () => firstStore.close());
    const source = await firstHistory.append({ sessionId, role: "user", content: "Project database is PostgreSQL." });
    await firstMemory.create({
      type: "decision",
      content: "Project database is PostgreSQL.",
      sourceReferences: [{ sessionId, messageId: source.id }],
      importance: 0.9,
      confidence: 0.9,
      sourceType: "explicit_user_statement",
      status: "active",
      scope: { kind: "project", id: "mnemos" },
    });
    const before = await normalizedRuntimeSnapshot(firstHistory, firstMemory, sessionId);
    firstHistory.close(); firstStore.close(); closers.splice(-2, 2);
    const restartedHistory = new SqliteHistoryStore(path);
    const restartedStore = new SqliteMemoryStore(path);
    const restartedMemory = new MemoryService(restartedStore, restartedHistory);
    closers.push(() => restartedHistory.close(), () => restartedStore.close());
    expect(await normalizedRuntimeSnapshot(restartedHistory, restartedMemory, sessionId)).toEqual(before);
    await assertReliabilityInvariants({ sessionId, history: restartedHistory, memories: restartedMemory });
  });

  it("keeps artifact metadata/body recovery explicit across restart and orphan cleanup", async () => {
    const { directory } = await database("mnemos-artifact-reliability-");
    const bodyDirectory = join(directory, "bodies");
    const databasePath = join(directory, "artifacts.sqlite");
    const store = new SqliteArtifactStore({ databasePath, storageDirectory: bodyDirectory });
    closers.push(() => store.close());
    const records = [];
    for (let index = 0; index < 32; index += 1) {
      records.push(await store.create({ scope: "persistent", type: "reliability", mimeType: "text/plain", content: `artifact-${index}\nneedle-${index}` }));
    }
    store.close(); closers.pop();
    const restarted = new SqliteArtifactStore({ databasePath, storageDirectory: bodyDirectory });
    closers.push(() => restarted.close());
    expect(await restarted.query(records[17]!.id, { query: "needle-17" })).toHaveLength(1);
    await writeFile(join(bodyDirectory, "orphan.blob"), "orphan");
    await unlink(join(bodyDirectory, records[0]!.storageLocation));
    const report = await restarted.recoverOrphans();
    expect(report.missingBodyIds).toEqual([records[0]!.id]);
    expect(report.deletedOrphanLocations).toContain("orphan.blob");
    expect((await readdir(bodyDirectory)).filter((name) => name === "orphan.blob")).toHaveLength(0);
  });

  it("makes consolidation retries durable and idempotent", async () => {
    const { path } = await database("mnemos-jobs-reliability-");
    const jobs = new SqliteConsolidationJobStore(path);
    closers.push(() => jobs.close());
    const eviction: ContextEviction = {
      compactionId: "00000000-0000-4000-8000-000000000001",
      sessionId: "s",
      evictedMessages: [],
      evictedMessageIds: ["00000000-0000-4000-8000-000000000002"],
      sourceRange: { firstMessageId: "00000000-0000-4000-8000-000000000002", lastMessageId: "00000000-0000-4000-8000-000000000002", messageCount: 1 },
      retainedFromMessageId: "00000000-0000-4000-8000-000000000003",
      cutoff: { kind: "turn", targetRetainedTokens: 10, actualRetainedTokens: 10, searchWindowTokens: 2, cutoffAfterMessageId: "00000000-0000-4000-8000-000000000002", cutoffBeforeMessageId: "00000000-0000-4000-8000-000000000003" },
      pinnedContext: { id: "automatic-compaction", sessionId: "s", source: "automatic", content: "summary", sourceRange: { firstMessageId: "00000000-0000-4000-8000-000000000002", lastMessageId: "00000000-0000-4000-8000-000000000002", messageCount: 1 } },
    };
    const first = await jobs.enqueue(eviction);
    const duplicate = await jobs.enqueue(eviction);
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    const claimed = await jobs.claimNext();
    expect(claimed?.attempts).toBe(1);
    await jobs.fail(claimed!.id, "injected");
    await jobs.retry(claimed!.id);
    const recovered = await jobs.claimNext();
    expect(recovered?.id).toBe(claimed!.id);
    await jobs.complete(recovered!.id);
    expect((await jobs.list(["completed"]))).toHaveLength(1);
  });

  it("does not let a failing event subscriber corrupt a successful persistence operation", async () => {
    const events = new EventBus();
    let observed = 0;
    events.on("memory.created", () => { throw new Error("audit sink unavailable"); });
    events.on("memory.created", () => { observed += 1; });
    await events.emit("memory.created", { jobId: "job", memory: {
      id: "00000000-0000-4000-8000-000000000001", type: "semantic", content: "fact", sourceIds: ["00000000-0000-4000-8000-000000000002"], sourceReferences: [{ sessionId: "s", messageId: "00000000-0000-4000-8000-000000000002" }], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", importance: 0.5, confidence: 0.5, sourceType: "explicit_user_statement", status: "active", derivedFromMemoryIds: [], confirmationCount: 1, reinforcementScore: 0, stale: false, durability: "normal", scope: { kind: "global", id: "global" }, entityRelations: [], entities: [], tags: [],
    } });
    expect(observed).toBe(1);
  });
});
