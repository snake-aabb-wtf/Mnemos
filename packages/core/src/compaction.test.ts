import { describe, expect, it } from "vitest";
import {
  BoundarySelector,
  CompactionService,
  ContextManager,
  EventBus,
  Harness,
  InMemoryContextCompactionStore,
  MockModelProvider,
  type HistoryMessage,
  type HistoryStore,
  type NewHistoryMessage,
  type StateStore,
  type TokenEstimator,
} from "./index.js";

const sessionId = "session-1";
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

function message(value: number, role: HistoryMessage["role"], metadata?: Record<string, unknown>): HistoryMessage {
  return {
    id: id(value),
    sessionId,
    role,
    content: `${role}-${value}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function turns(count: number, start = 1): HistoryMessage[] {
  return Array.from({ length: count }, (_, index) => [
    message(start + index * 2, "user"),
    message(start + index * 2 + 1, "assistant"),
  ]).flat();
}

class FixedMessageEstimator implements TokenEstimator {
  constructor(private readonly messageTokens: number) {}
  estimateText(text: string): number { return Math.ceil(text.length / 4); }
  estimateMessage(): number { return this.messageTokens; }
}

class ArrayHistoryStore implements HistoryStore {
  private sequence: number;
  constructor(private readonly messages: HistoryMessage[] = []) {
    this.sequence = messages.length;
  }

  async append(input: NewHistoryMessage): Promise<HistoryMessage> {
    const stored: HistoryMessage = {
      id: input.id ?? id(++this.sequence),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    };
    this.messages.push(stored);
    return stored;
  }

  async get(targetSession: string, messageId: string): Promise<HistoryMessage | undefined> {
    return this.messages.find((entry) => entry.sessionId === targetSession && entry.id === messageId);
  }

  async list(targetSession: string): Promise<HistoryMessage[]> {
    return this.messages.filter((entry) => entry.sessionId === targetSession);
  }
}

class TestStateStore implements StateStore {
  async get<T extends Record<string, unknown>>(): Promise<T | undefined> { return undefined; }
  async set<T extends Record<string, unknown>>(_: string, value: T): Promise<T> { return value; }
  async patch<T extends Record<string, unknown>>(_: string, value: Partial<T>): Promise<T> { return value as T; }
}

function context(estimator: TokenEstimator, overrides: Partial<ConstructorParameters<typeof ContextManager>[1]> = {}): ContextManager {
  return new ContextManager(estimator, {
    contextLimit: 100,
    reservedTokens: 10,
    recentRawTokenBudget: 40,
    pinnedTokenBudget: 30,
    softPressureThreshold: 0.6,
    highPressureThreshold: 0.85,
    emergencyPressureThreshold: 0.92,
    ...overrides,
  });
}

describe("BoundarySelector", () => {
  it("chooses a task boundary near the target without splitting user/assistant turns", () => {
    const entries = [
      message(1, "user", { taskId: "research" }),
      message(2, "assistant", { taskId: "research" }),
      message(3, "user", { taskId: "implementation" }),
      message(4, "assistant", { taskId: "implementation" }),
      message(5, "user", { taskId: "verification" }),
      message(6, "assistant", { taskId: "verification" }),
    ];
    const selection = new BoundarySelector(new FixedMessageEstimator(10), 10).select(entries, 20)!;

    expect(selection.kind).toBe("task");
    expect(selection.evictedMessages.map((entry) => entry.id)).toEqual([id(1), id(2), id(3), id(4)]);
    expect(selection.retainedMessages.map((entry) => entry.id)).toEqual([id(5), id(6)]);
  });

  it("keeps an entire tool-call transaction together when no user turn encloses it", () => {
    const entries = [
      message(1, "assistant", { transactionId: "tool-1" }),
      message(2, "tool", { transactionId: "tool-1" }),
      message(3, "assistant"),
      message(4, "assistant"),
    ];
    const selection = new BoundarySelector(new FixedMessageEstimator(10), 10).select(entries, 20)!;

    expect(selection.evictedMessages.map((entry) => entry.id)).toEqual([id(1), id(2)]);
    expect(selection.cutoffAfterMessageId).toBe(id(2));
    expect(selection.cutoffBeforeMessageId).toBe(id(3));
  });
});

describe("CompactionService", () => {
  it("advances a durable checkpoint, updates one automatic pin, and never re-evicts source messages", async () => {
    const history = new ArrayHistoryStore(turns(3));
    const checkpoints = new InMemoryContextCompactionStore();
    const manager = context(new FixedMessageEstimator(10));
    const summaryCalls: number[] = [];
    const service = new CompactionService({
      history,
      checkpoints,
      context: manager,
      cutoffSearchWindowTokens: 10,
      summarizer: {
        async summarize(request) {
          summaryCalls.push(request.sourceRange.messageCount);
          return `deterministic summary through ${request.sourceRange.lastMessageId}`;
        },
      },
    });

    const first = await service.prepare(sessionId);
    expect(first.evictions).toHaveLength(1);
    expect(first.evictions[0].evictedMessageIds).toEqual([id(1), id(2)]);
    expect(first.context.recentMessages.map((entry) => entry.id)).toEqual([id(3), id(4), id(5), id(6)]);
    expect(first.context.pinned).toHaveLength(1);
    expect(first.context.pinned[0].content).toContain(`through ${id(2)}`);
    expect(first.context.pinned[0].sourceRange).toMatchObject({ firstMessageId: id(1), lastMessageId: id(2), messageCount: 2 });
    expect((await history.list(sessionId)).map((entry) => entry.id)).toEqual([id(1), id(2), id(3), id(4), id(5), id(6)]);
    expect((await history.get(sessionId, id(1)))?.content).toBe("user-1");

    expect((await service.prepare(sessionId)).evictions).toHaveLength(0);
    await history.append({ sessionId, role: "user", content: "user-7" });
    await history.append({ sessionId, role: "assistant", content: "assistant-8" });
    const second = await service.prepare(sessionId);
    expect(second.evictions).toHaveLength(1);
    expect(second.evictions[0].evictedMessageIds).toEqual([id(3), id(4)]);
    expect(second.context.pinned[0].sourceRange).toMatchObject({ firstMessageId: id(1), lastMessageId: id(4), messageCount: 4 });
    expect(second.context.pinned[0].content).toContain(`through ${id(4)}`);
    expect(summaryCalls).toEqual([2, 4]);
    expect((await history.list(sessionId))).toHaveLength(8);
  });

  it("emits complete, source-addressable evictions through Harness after the pin/checkpoint update", async () => {
    const history = new ArrayHistoryStore();
    const checkpoints = new InMemoryContextCompactionStore();
    const manager = context(new FixedMessageEstimator(10));
    const service = new CompactionService({ history, checkpoints, context: manager, cutoffSearchWindowTokens: 10 });
    const events = new EventBus();
    const evictions: string[][] = [];
    events.on("context.evicted", (event) => {
      expect(event.pinnedContext.sourceRange?.lastMessageId).toBe(event.cutoff.cutoffAfterMessageId);
      evictions.push([...event.evictedMessageIds]);
    });
    const visibleRawTokenCounts: number[] = [];
    const harness = new Harness({
      history,
      state: new TestStateStore(),
      context: manager,
      compaction: service,
      events,
      provider: new MockModelProvider(({ input, context: modelContext }) => {
        visibleRawTokenCounts.push(modelContext.stats.recentRawTokens);
        return { content: `ok:${input}` };
      }),
      logger: { debug: () => undefined } as never,
    });

    for (const input of ["one", "two", "three", "four", "five"]) await harness.send(sessionId, input);

    const allEvicted = evictions.flat();
    expect(allEvicted.length).toBeGreaterThan(0);
    expect(new Set(allEvicted).size).toBe(allEvicted.length);
    expect(visibleRawTokenCounts.every((count) => count <= 40)).toBe(true);
    expect(manager.listPins(sessionId)).toHaveLength(1);
    expect((await history.list(sessionId))).toHaveLength(10);
    expect((await checkpoints.get(sessionId))?.automaticPin?.sourceRange?.messageCount).toBe(allEvicted.length);
  });

  it.each([200_000, 500_000, 1_000_000])("keeps simulated %i-token histories bounded and source-retrievable", async (totalTokens) => {
    const tokensPerMessage = 1_000;
    const history = new ArrayHistoryStore(turns(totalTokens / (tokensPerMessage * 2)));
    const checkpoints = new InMemoryContextCompactionStore();
    const manager = new ContextManager(new FixedMessageEstimator(tokensPerMessage));
    const service = new CompactionService({ history, checkpoints, context: manager });

    const result = await service.prepare(sessionId);
    const evicted = result.evictions.flatMap((event) => event.evictedMessages);
    expect(result.context.stats.recentRawTokens).toBeLessThanOrEqual(48_000);
    expect(result.context.stats.usedTokens + result.context.stats.reservedTokens).toBeLessThan(128_000);
    expect(evicted.length).toBeGreaterThan(0);
    expect((await history.list(sessionId))).toHaveLength(totalTokens / tokensPerMessage);
    expect((await history.get(sessionId, evicted[0].id))?.id).toBe(evicted[0].id);
    expect((await checkpoints.get(sessionId))?.evictedThroughMessageId).toBe(evicted.at(-1)?.id);
  });
});
