import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CompactionService,
  ContextManager,
  EventBus,
  Harness,
  MemoryConsolidationService,
  MemoryService,
  MockModelProvider,
  type ConsolidationDecision,
  type ContextEviction,
  type HiddenAgent,
  type HiddenExtractionRequest,
  type HiddenMemoryCandidate,
  type HiddenReconciliationRequest,
  type MemoryCreateInput,
} from "@mnemos/core";
import { SqliteConsolidationJobStore } from "./consolidation.js";
import { SqliteMemoryStore } from "./memory.js";
import { SqliteContextCompactionStore, SqliteHistoryStore, SqliteStateStore } from "./sqlite.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function database(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), "mnemos-consolidation-"));
  return join(directory, "runtime.sqlite");
}

class ScriptedHiddenAgent implements HiddenAgent {
  readonly extractionRequests: HiddenExtractionRequest[] = [];
  readonly reconciliationRequests: HiddenReconciliationRequest[] = [];

  constructor(private readonly extractions: unknown[], private readonly proposals: unknown[]) {}

  async extract(request: HiddenExtractionRequest): Promise<unknown> {
    this.extractionRequests.push(request);
    const next = this.extractions.shift();
    if (next instanceof Error) throw next;
    return next ?? { candidates: [] };
  }

  async reconcile(request: HiddenReconciliationRequest): Promise<unknown> {
    this.reconciliationRequests.push(request);
    const next = this.proposals.shift();
    if (next instanceof Error) throw next;
    return next ?? { decisions: [] };
  }
}

function candidate(messageId: string, content: string, overrides: Partial<HiddenMemoryCandidate> = {}): HiddenMemoryCandidate {
  return {
    content,
    type: "decision",
    importance: 0.8,
    confidence: 0.9,
    sourceType: "explicit_user_statement",
    sourceReferences: [{ sessionId: "session-a", messageId }],
    entities: ["database"],
    tags: ["architecture"],
    retrievalQuery: "database",
    status: "active",
    ...overrides,
  };
}

function eviction(sessionId: string, messageIds: readonly string[]): ContextEviction {
  const sourceRange = {
    firstMessageId: messageIds[0],
    lastMessageId: messageIds.at(-1)!,
    messageCount: messageIds.length,
  };
  return {
    compactionId: randomUUID(),
    sessionId,
    evictedMessages: [],
    evictedMessageIds: messageIds,
    sourceRange,
    retainedFromMessageId: randomUUID(),
    cutoff: {
      kind: "turn",
      targetRetainedTokens: 10,
      actualRetainedTokens: 10,
      searchWindowTokens: 2,
      cutoffAfterMessageId: messageIds.at(-1)!,
      cutoffBeforeMessageId: randomUUID(),
    },
    pinnedContext: {
      id: "automatic-compaction",
      sessionId,
      source: "automatic",
      content: "Pinned source range",
      sourceRange,
    },
  };
}

function memoryInput(messageId: string, content: string): MemoryCreateInput {
  return {
    type: "decision",
    content,
    sourceReferences: [{ sessionId: "session-a", messageId }],
    importance: 0.8,
    confidence: 0.9,
    sourceType: "explicit_user_statement",
    status: "active",
    entities: ["database"],
    tags: ["architecture"],
  };
}

async function runtime(path: string, hiddenAgent: HiddenAgent, events?: EventBus) {
  const history = new SqliteHistoryStore(path);
  const store = new SqliteMemoryStore(path);
  const jobs = new SqliteConsolidationJobStore(path);
  const memories = new MemoryService(store, history);
  const consolidation = new MemoryConsolidationService({ history, memories, jobs, hiddenAgent, events });
  return { history, store, jobs, memories, consolidation };
}

describe("Phase 4 hidden-agent consolidation", () => {
  it("extracts durable facts, preferences, decisions, and episodes while ignoring chatter, with source traces", async () => {
    const path = await database();
    const events = new EventBus();
    events.on("memory.created", () => { throw new Error("observer unavailable"); });
    const hidden = new ScriptedHiddenAgent([], []);
    const app = await runtime(path, hidden, events);
    const messages = await Promise.all([
      app.history.append({ sessionId: "session-a", role: "user", content: "The API must keep audit logs for seven years." }),
      app.history.append({ sessionId: "session-a", role: "user", content: "I prefer dark mode in the admin console." }),
      app.history.append({ sessionId: "session-a", role: "user", content: "We decided to use SQLite for the local project database." }),
      app.history.append({ sessionId: "session-a", role: "user", content: "The production migration completed on Friday." }),
      app.history.append({ sessionId: "session-a", role: "user", content: "haha" }),
    ]);
    const candidates = [
      candidate(messages[0].id, "Audit logs are retained for seven years.", { type: "semantic", entities: ["audit logs"] }),
      candidate(messages[1].id, "User prefers dark mode in the admin console.", { type: "preference", entities: ["admin console"] }),
      candidate(messages[2].id, "Local project database uses SQLite.", { type: "decision" }),
      candidate(messages[3].id, "Production migration completed on Friday.", { type: "episodic", entities: ["production migration"] }),
    ];
    hidden["extractions"].push({ candidates });
    hidden["proposals"].push({ decisions: [
      ...candidates.map((entry) => ({ kind: "new" as const, candidate: entry })),
      { kind: "irrelevant" as const, reason: "Chatter has no durable value" },
    ] });
    await app.jobs.enqueue(eviction("session-a", messages.map((message) => message.id)));

    const result = await app.consolidation.processNext();
    expect(result?.operations.map((operation) => operation.kind)).toEqual(["new", "new", "new", "new", "irrelevant"]);
    expect(result?.job.status).toBe("completed");
    const records = await app.memories.list();
    expect(records.map((record) => record.type)).toEqual(["semantic", "preference", "decision", "episodic"]);
    expect(await app.memories.source(records[2].id)).toMatchObject({ messages: [{ id: messages[2].id }] });
    expect(hidden.reconciliationRequests[0].candidates).toHaveLength(4);
    app.jobs.close(); app.store.close(); app.history.close();
  });

  it("deduplicates confirmations and merges, rather than replaces, source references during updates", async () => {
    const path = await database();
    const hidden = new ScriptedHiddenAgent([], []);
    const app = await runtime(path, hidden);
    const original = await app.history.append({ sessionId: "session-a", role: "user", content: "The project uses SQLite." });
    const existing = await app.memories.create(memoryInput(original.id, "Project uses SQLite for local persistence."));
    const confirmation = await app.history.append({ sessionId: "session-a", role: "user", content: "SQLite remains the database." });
    const expansion = await app.history.append({ sessionId: "session-a", role: "user", content: "SQLite runs with Node.js 22." });
    const confirmed = candidate(confirmation.id, "Project uses SQLite for local persistence.");
    const expanded = candidate(expansion.id, "Project uses SQLite and Node.js 22 for local persistence.");
    hidden["extractions"].push({ candidates: [confirmed] }, { candidates: [expanded] });
    hidden["proposals"].push(
      { decisions: [{ kind: "duplicate", existingMemoryId: existing.id, sourceReferences: confirmed.sourceReferences }] },
      { decisions: [{ kind: "update", existingMemoryId: existing.id, patch: { content: expanded.content, tags: ["architecture", "runtime"] }, sourceReferences: expanded.sourceReferences }] },
    );
    await app.jobs.enqueue(eviction("session-a", [confirmation.id]));
    await app.jobs.enqueue(eviction("session-a", [expansion.id]));
    await app.consolidation.processAvailable();

    const updated = await app.memories.get(existing.id);
    expect(updated).toMatchObject({ content: expanded.content, tags: ["architecture", "runtime"] });
    expect(updated?.sourceReferences.map((source) => source.messageId)).toEqual([original.id, confirmation.id, expansion.id]);
    expect(updated?.lastConfirmedAt).toBeTruthy();
    expect(await app.memories.list()).toHaveLength(1);
    app.jobs.close(); app.store.close(); app.history.close();
  });

  it("uses the Phase 3 atomic supersede transition for SQLite → PostgreSQL → PostgreSQL + Redis", async () => {
    const path = await database();
    const hidden = new ScriptedHiddenAgent([], []);
    const app = await runtime(path, hidden);
    const sqliteMessage = await app.history.append({ sessionId: "session-a", role: "user", content: "Use SQLite." });
    const sqlite = await app.memories.create(memoryInput(sqliteMessage.id, "Project database uses SQLite."));
    const postgresMessage = await app.history.append({ sessionId: "session-a", role: "user", content: "Database changed to PostgreSQL." });
    const redisMessage = await app.history.append({ sessionId: "session-a", role: "user", content: "Final database stack is PostgreSQL plus Redis." });
    const postgres = candidate(postgresMessage.id, "Project database uses PostgreSQL.");
    const redis = candidate(redisMessage.id, "Project database uses PostgreSQL plus Redis.");
    hidden["extractions"].push({ candidates: [postgres] }, { candidates: [redis] });
    hidden["proposals"].push(
      { decisions: [{ kind: "supersede", existingMemoryId: sqlite.id, replacement: postgres }] },
      { decisions: [{ kind: "supersede", existingMemoryId: "00000000-0000-4000-8000-000000000000", replacement: redis }] },
    );
    await app.jobs.enqueue(eviction("session-a", [postgresMessage.id]));
    const first = await app.consolidation.processNext();
    const postgresql = first?.operations.find((operation) => operation.kind === "supersede");
    if (!postgresql || postgresql.kind !== "supersede") throw new Error("Expected PostgreSQL supersession");
    hidden["proposals"][0] = { decisions: [{ kind: "supersede", existingMemoryId: postgresql.replacement.id, replacement: redis }] };
    await app.jobs.enqueue(eviction("session-a", [redisMessage.id]));
    await app.consolidation.processNext();

    const timeline = await app.memories.timeline({ entity: "database" });
    expect(timeline.map((record) => [record.content, record.status])).toEqual([
      ["Project database uses SQLite.", "superseded"],
      ["Project database uses PostgreSQL.", "superseded"],
      ["Project database uses PostgreSQL plus Redis.", "active"],
    ]);
    expect((await app.memories.search({ query: "database" })).map((entry) => entry.memory.content)).toEqual(["Project database uses PostgreSQL plus Redis."]);
    app.jobs.close(); app.store.close(); app.history.close();
  });

  it("rejects malformed, ungrounded, and overconfident inference proposals without writing Memory, then retries", async () => {
    const path = await database();
    const hidden = new ScriptedHiddenAgent([{ candidates: [{ unsupported: true }] }], []);
    const app = await runtime(path, hidden);
    const message = await app.history.append({ sessionId: "session-a", role: "user", content: "Use SQLite." });
    const queued = await app.jobs.enqueue(eviction("session-a", [message.id]));
    await expect(app.consolidation.processNext()).rejects.toThrow();
    expect((await app.jobs.get(queued.job.id))?.status).toBe("failed");
    expect(await app.memories.list()).toHaveLength(0);

    await app.jobs.retry(queued.job.id);
    hidden["extractions"].push({ candidates: [candidate(randomUUID(), "Ungrounded fact")] });
    await expect(app.consolidation.processNext()).rejects.toThrow("outside its evicted History");
    await app.jobs.retry(queued.job.id);
    hidden["extractions"].push({ candidates: [candidate(message.id, "Inferred preference", { sourceType: "assistant_inference", confidence: 0.9 })] });
    await expect(app.consolidation.processNext()).rejects.toThrow("confidence");
    expect(await app.memories.list()).toHaveLength(0);

    await app.jobs.retry(queued.job.id);
    const valid = candidate(message.id, "Project uses SQLite.");
    hidden["extractions"].push({ candidates: [valid] });
    hidden["proposals"].push({ decisions: [{ kind: "new", candidate: valid }] });
    await app.consolidation.processNext();
    expect((await app.jobs.get(queued.job.id))?.status).toBe("completed");
    expect(await app.memories.list()).toHaveLength(1);
    app.jobs.close(); app.store.close(); app.history.close();
  });

  it("deduplicates repeated eviction delivery and recovers pending or interrupted work after restart", async () => {
    const path = await database();
    const messageId = randomUUID();
    const initialHistory = new SqliteHistoryStore(path);
    const message = await initialHistory.append({ id: messageId, sessionId: "session-a", role: "user", content: "Use SQLite." });
    initialHistory.close();
    const agent = new ScriptedHiddenAgent([], []);
    const firstJobs = new SqliteConsolidationJobStore(path);
    const first = await firstJobs.enqueue(eviction("session-a", [message.id]));
    const repeated = await firstJobs.enqueue(eviction("session-a", [message.id]));
    expect(repeated).toMatchObject({ created: false, job: { id: first.job.id } });
    await firstJobs.claimNext();
    firstJobs.close();

    const app = await runtime(path, agent);
    const durable = candidate(message.id, "Project uses SQLite.");
    agent["extractions"].push({ candidates: [durable] });
    agent["proposals"].push({ decisions: [{ kind: "new", candidate: durable }] });
    await app.consolidation.processNext();
    expect((await app.jobs.get(first.job.id))).toMatchObject({ status: "completed", attempts: 2 });
    expect(await app.memories.list()).toHaveLength(1);
    expect(await app.consolidation.processNext()).toBeUndefined();
    app.jobs.close(); app.store.close(); app.history.close();
  });

  it("queues memory.remember hints for Hidden Agent reconciliation without granting direct Memory writes", async () => {
    const path = await database();
    const hidden = new ScriptedHiddenAgent([], []);
    const app = await runtime(path, hidden);
    const source = await app.history.append({ sessionId: "session-a", role: "user", content: "Remember that I prefer dark mode." });
    const hint = candidate(source.id, "User prefers dark mode.", {
      type: "preference",
      entities: ["admin console"],
      tags: ["ui"],
    });
    const queued = await app.consolidation.remember({ sessionId: "session-a", candidate: hint });
    expect(queued.job).toMatchObject({ origin: "visible-candidate", status: "pending", candidateHints: [hint] });
    expect(await app.memories.list()).toHaveLength(0);

    hidden["extractions"].push({ candidates: [hint] });
    hidden["proposals"].push({ decisions: [{ kind: "new", candidate: hint }] });
    await app.consolidation.processNext();
    expect(hidden.extractionRequests[0].job.candidateHints).toEqual([hint]);
    expect(await app.memories.list()).toHaveLength(1);
    app.jobs.close(); app.store.close(); app.history.close();
  });

  it("marks a job failed, rather than completed, when the MemoryStore write path fails", async () => {
    const path = await database();
    const hidden = new ScriptedHiddenAgent([], []);
    const app = await runtime(path, hidden);
    const source = await app.history.append({ sessionId: "session-a", role: "user", content: "Use SQLite." });
    const durable = candidate(source.id, "Project uses SQLite.");
    hidden["extractions"].push({ candidates: [durable] });
    hidden["proposals"].push({ decisions: [{ kind: "new", candidate: durable }] });
    const queued = await app.jobs.enqueue(eviction("session-a", [source.id]));
    app.store.close();

    await expect(app.consolidation.processNext()).rejects.toThrow();
    expect((await app.jobs.get(queued.job.id))?.status).toBe("failed");
    const reopened = new SqliteMemoryStore(path);
    expect(await reopened.list()).toHaveLength(0);
    reopened.close(); app.jobs.close(); app.history.close();
  });

  it("emits durable consolidation and Memory lifecycle events after their corresponding transitions", async () => {
    const path = await database();
    const events = new EventBus();
    const observed: string[] = [];
    events.on("memory.consolidation.requested", () => { observed.push("requested"); });
    events.on("memory.consolidation.started", () => { observed.push("started"); });
    events.on("memory.created", () => { observed.push("created"); });
    events.on("memory.consolidation.completed", () => { observed.push("completed"); });
    const hidden = new ScriptedHiddenAgent([], []);
    const app = await runtime(path, hidden, events);
    app.consolidation.attach(events);
    const source = await app.history.append({ sessionId: "session-a", role: "user", content: "Use SQLite." });
    const durable = candidate(source.id, "Project uses SQLite.");
    hidden["extractions"].push({ candidates: [durable] });
    hidden["proposals"].push({ decisions: [{ kind: "new", candidate: durable }] });
    await events.emit("context.evicted", eviction("session-a", [source.id]));
    await app.consolidation.processNext();
    expect(observed).toEqual(["requested", "started", "created", "completed"]);
    app.jobs.close(); app.store.close(); app.history.close();
  });

  it("keeps hidden-agent failures out of Harness.send while a context.evicted listener creates durable work", async () => {
    const path = await database();
    const events = new EventBus();
    const hidden = new ScriptedHiddenAgent([new Error("hidden provider unavailable")], []);
    const app = await runtime(path, hidden, events);
    app.consolidation.attach(events);
    const context = new ContextManager(undefined, {
      contextLimit: 160,
      reservedTokens: 16,
      recentRawTokenBudget: 50,
      pinnedTokenBudget: 20,
      softPressureThreshold: 0.4,
      highPressureThreshold: 0.6,
      emergencyPressureThreshold: 0.8,
    });
    const state = new SqliteStateStore(path);
    const checkpoints = new SqliteContextCompactionStore(path);
    const harness = new Harness({
      history: app.history,
      state,
      context,
      events,
      provider: new MockModelProvider(() => ({ content: "ack" })),
      compaction: new CompactionService({ history: app.history, checkpoints, context }),
    });
    await expect(harness.send("session-a", `SQLite choice ${"context ".repeat(15)}`)).resolves.toBeDefined();
    await expect(harness.send("session-a", `More context ${"history ".repeat(15)}`)).resolves.toBeDefined();
    expect(await app.jobs.list()).toHaveLength(1);
    await expect(app.consolidation.processNext()).rejects.toThrow("hidden provider unavailable");
    expect((await app.jobs.list(["failed"]))).toHaveLength(1);
    checkpoints.close(); state.close(); app.jobs.close(); app.store.close(); app.history.close();
  });

  it("runs the Phase 2 → Phase 4 SQLite-to-PostgreSQL evolution end to end", async () => {
    const path = await database();
    const events = new EventBus();
    const dynamicAgent: HiddenAgent = {
      async extract(request) {
        const user = request.evictedMessages.find((message) => message.role === "user");
        if (!user) return { candidates: [] };
        if (user.content.includes("SQLite")) return { candidates: [candidate(user.id, "Project database uses SQLite.")] };
        if (user.content.includes("PostgreSQL")) return { candidates: [candidate(user.id, "Project database uses PostgreSQL.")] };
        return { candidates: [] };
      },
      async reconcile(request) {
        const input = request.candidates[0];
        if (!input) return { decisions: [{ kind: "irrelevant", reason: "No durable candidate" }] };
        const sqlite = input.relatedMemories.find((memory) => memory.content.includes("SQLite"));
        return sqlite
          ? { decisions: [{ kind: "supersede", existingMemoryId: sqlite.id, replacement: input.candidate }] }
          : { decisions: [{ kind: "new", candidate: input.candidate }] };
      },
    };
    const app = await runtime(path, dynamicAgent, events);
    app.consolidation.attach(events);
    const context = new ContextManager(undefined, {
      contextLimit: 160,
      reservedTokens: 16,
      recentRawTokenBudget: 50,
      pinnedTokenBudget: 20,
      softPressureThreshold: 0.4,
      highPressureThreshold: 0.6,
      emergencyPressureThreshold: 0.8,
    });
    const state = new SqliteStateStore(path);
    const checkpoints = new SqliteContextCompactionStore(path);
    const harness = new Harness({
      history: app.history,
      state,
      context,
      events,
      provider: new MockModelProvider(() => ({ content: "ack" })),
      compaction: new CompactionService({ history: app.history, checkpoints, context }),
    });
    const sqliteText = `This project database choice is SQLite. ${"background ".repeat(11)}`;
    const postgresText = `The project database has changed to PostgreSQL. ${"background ".repeat(10)}`;
    await harness.send("session-a", sqliteText);
    await harness.send("session-a", postgresText);
    await app.consolidation.processAvailable();
    expect((await app.memories.search({ query: "database" })).map((entry) => entry.memory.content)).toEqual(["Project database uses SQLite."]);

    await harness.send("session-a", `Filler context ${"background ".repeat(14)}`);
    await app.consolidation.processAvailable();
    const current = await app.memories.search({ query: "database" });
    expect(current.map((entry) => entry.memory.content)).toEqual(["Project database uses PostgreSQL."]);
    const timeline = await app.memories.timeline({ entity: "database" });
    expect(timeline.map((entry) => [entry.content, entry.status])).toEqual([
      ["Project database uses SQLite.", "superseded"],
      ["Project database uses PostgreSQL.", "active"],
    ]);
    const sqliteTrace = await app.memories.source(timeline[0].id);
    const postgresTrace = await app.memories.source(timeline[1].id);
    expect(sqliteTrace.messages[0].content).toContain("SQLite");
    expect(postgresTrace.messages[0].content).toContain("PostgreSQL");
    expect((await app.jobs.list(["completed"])).length).toBeGreaterThanOrEqual(2);
    checkpoints.close(); state.close(); app.jobs.close(); app.store.close(); app.history.close();
  });
});
