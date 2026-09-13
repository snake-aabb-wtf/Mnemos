import { describe, expect, it } from "vitest";
import { ContextManager, EventBus, Harness, MockModelProvider, type HarnessEventMap, type HistoryMessage, type HistoryStore, type StateStore } from "./index.js";

class TestHistoryStore implements HistoryStore {
  private entries: HistoryMessage[] = [];
  private sequence = 0;

  async append(message: Omit<HistoryMessage, "id" | "createdAt">): Promise<HistoryMessage> {
    const entry: HistoryMessage = {
      ...message,
      id: `00000000-0000-4000-8000-${String(++this.sequence).padStart(12, "0")}`,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    this.entries.push(entry);
    return entry;
  }

  async get(sessionId: string, messageId: string): Promise<HistoryMessage | undefined> {
    return this.entries.find((entry) => entry.sessionId === sessionId && entry.id === messageId);
  }

  async list(sessionId: string): Promise<HistoryMessage[]> {
    return this.entries.filter((entry) => entry.sessionId === sessionId);
  }
}

class TestStateStore implements StateStore {
  private values = new Map<string, Record<string, unknown>>();
  async get<T extends Record<string, unknown>>(sessionId: string): Promise<T | undefined> { return this.values.get(sessionId) as T | undefined; }
  async set<T extends Record<string, unknown>>(sessionId: string, state: T): Promise<T> { this.values.set(sessionId, state); return state; }
  async patch<T extends Record<string, unknown>>(sessionId: string, patch: Partial<T>): Promise<T> {
    return this.set(sessionId, { ...(await this.get<T>(sessionId) ?? {}), ...patch } as T);
  }
}

describe("Harness", () => {
  it("persists both sides of a mock conversation and requests compaction under pressure", async () => {
    const history = new TestHistoryStore();
    const events = new EventBus<HarnessEventMap>();
    const pressureReasons: string[] = [];
    events.on("context.compaction.requested", ({ reason }) => { pressureReasons.push(reason); });
    const harness = new Harness({
      history,
      state: new TestStateStore(),
      provider: new MockModelProvider(({ input, context }) => ({ content: `echo:${input}`, metadata: { rawCount: context.recentMessages.length } })),
      context: new ContextManager(undefined, { contextLimit: 50, reservedTokens: 10, recentRawTokenBudget: 40 }),
      events,
      logger: { debug: () => undefined } as never,
    });

    const reply = await harness.send("s-1", "x".repeat(120));
    expect(reply.content).toBe(`echo:${"x".repeat(120)}`);
    expect((await history.list("s-1")).map((entry) => entry.role)).toEqual(["user", "assistant"]);
    expect(pressureReasons).toContain("emergency");

    await harness.setState("s-1", { task: "phase-1" });
    expect(await harness.patchState("s-1", { status: "done" })).toEqual({ task: "phase-1", status: "done" });
  });
});
