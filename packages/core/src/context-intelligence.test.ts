import { describe, expect, it } from "vitest";
import { CharacterTokenEstimator, ContextManager, ContextPolicyEngine, Harness, MockModelProvider, type ContextStats, type HistoryMessage, type HistoryStore, type StateStore } from "./index.js";

const message = (id: number, content: string, role: HistoryMessage["role"] = "user"): HistoryMessage => ({
  id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
  sessionId: "session",
  role,
  content,
  createdAt: "2026-01-01T00:00:00.000Z",
});

class History implements HistoryStore {
  readonly entries: HistoryMessage[] = [];
  async append(input: Omit<HistoryMessage, "id" | "createdAt">): Promise<HistoryMessage> { const item = message(this.entries.length + 1, input.content, input.role); this.entries.push({ ...item, ...input }); return this.entries.at(-1)!; }
  async get(sessionId: string, id: string): Promise<HistoryMessage | undefined> { return this.entries.find((item) => item.sessionId === sessionId && item.id === id); }
  async list(sessionId: string): Promise<HistoryMessage[]> { return this.entries.filter((item) => item.sessionId === sessionId); }
}

class State implements StateStore {
  private readonly values = new Map<string, Record<string, unknown>>();
  async get<T extends Record<string, unknown>>(sessionId: string): Promise<T | undefined> { return this.values.get(sessionId) as T | undefined; }
  async set<T extends Record<string, unknown>>(sessionId: string, value: T): Promise<T> { this.values.set(sessionId, value); return value; }
  async patch<T extends Record<string, unknown>>(sessionId: string, patch: Partial<T>): Promise<T> { return this.set(sessionId, { ...(await this.get<T>(sessionId) ?? {}), ...patch } as T); }
}

describe("Phase 10 Context Intelligence", () => {
  it("accounts every visible component, reserves generation output, and exposes pressure levels", () => {
    const context = new ContextManager(new CharacterTokenEstimator(), {
      contextLimit: 100, reservedTokens: 20, recentRawTokenBudget: 80,
      elevatedPressureThreshold: 0.6, highPressureThreshold: 0.75, compactionPressureThreshold: 0.85, emergencyPressureThreshold: 0.92,
    });
    const visible = context.buildVisible("s", [message(1, "x".repeat(240))], "system", [], ["schema"]);
    expect(visible.stats.usedTokens).toBe(68);
    expect(visible.stats.availableTokens).toBe(32);
    expect(visible.stats.safeHeadroomTokens).toBe(12);
    expect(visible.stats.generationReserveTokens).toBe(20);
    expect(visible.stats.pressureLevel).toBe("COMPACTION");
    expect(context.isSafeForModel(visible)).toBe(true);
  });

  it("uses deterministic hysteresis and produces typed policy actions", () => {
    const context = new ContextManager(undefined, { contextLimit: 100, reservedTokens: 10, pressureHysteresis: 0.03 });
    const engine = new ContextPolicyEngine();
    const base: ContextStats = { usedTokens: 70, contextLimit: 100, availableTokens: 30, safeHeadroomTokens: 20, systemTokens: 0, pinnedTokens: 0, recentRawTokens: 70, artifactHandleTokens: 0, toolSchemaTokens: 0, retrievedMemoryTokens: 0, toolResultTokens: 0, reservedTokens: 10, generationReserveTokens: 10, pressure: 0.8, pressureLevel: "HIGH" };
    expect(engine.evaluate(base, context.budgets, "s").level).toBe("HIGH");
    expect(engine.evaluate({ ...base, pressure: 0.79 }, context.budgets, "s").level).toBe("HIGH");
    expect(engine.evaluate({ ...base, pressure: 0.7 }, context.budgets, "s").level).toBe("ELEVATED");
    expect(engine.evaluate({ ...base, pressure: 0.5 }, context.budgets, "s").level).toBe("NORMAL");
    expect(engine.evaluate({ ...base, pressure: 0.95 }, context.budgets, "s").recommendations).toContain("do_not_invoke_model_until_context_reduced");
  });

  it("enforces agent pin budget, ownership, dedupe, and turn TTL without touching system/automatic pins", () => {
    const context = new ContextManager(new CharacterTokenEstimator(), { contextLimit: 1000, reservedTokens: 10, pinnedTokenBudget: 100, agentPinnedTokenBudget: 5 });
    context.addPin({ id: "system", content: "system", source: "system" });
    context.addPin({ id: "auto", content: "automatic", source: "automatic", sessionId: "s" });
    context.addPin({ id: "goal", content: "a".repeat(20), source: "visible-agent", sessionId: "s", expiresAtTurn: 2 });
    context.addPin({ id: "duplicate", content: " " + "a".repeat(20) + " ", source: "visible-agent", sessionId: "s" });
    expect(context.listPins("s").map((pin) => pin.id)).toContain("goal");
    expect(() => context.addPin({ id: "overflow", content: "bbbb", source: "visible-agent", sessionId: "s" })).toThrow(/Agent pinned/);
    expect(context.removeAgentPin("system", "s")).toBe(false);
    context.advanceTurn("s");
    context.advanceTurn("s");
    expect(context.listPins("s").map((pin) => pin.id)).not.toContain("goal");
    expect(context.listPins("s").map((pin) => pin.id)).toContain("auto");
  });

  it("packs million-token simulated working sets while preserving a safe model headroom", () => {
    const context = new ContextManager(new CharacterTokenEstimator(), { contextLimit: 128_000, reservedTokens: 20_000, recentRawTokenBudget: 48_000 });
    const history = Array.from({ length: 10_000 }, (_, index) => message(index + 1, "token ".repeat(100)));
    const visible = context.build(history, "system");
    expect(visible.stats.usedTokens + visible.stats.generationReserveTokens).toBeLessThanOrEqual(128_000);
    expect(visible.recentMessages.length).toBeLessThan(history.length);
    expect(context.packWithinTokenBudget(history, 4_000).items.length).toBeGreaterThan(0);
    console.info("context-eval", JSON.stringify({ peakContextTokens: visible.stats.usedTokens, safeHeadroomTokens: visible.stats.safeHeadroomTokens, rawMessages: visible.recentMessages.length, simulatedHistoryMessages: history.length }));
  });

  it("never invokes a provider for an irreducible emergency overflow", async () => {
    const history = new History();
    const oversized = "x".repeat(500);
    const context = new ContextManager(new CharacterTokenEstimator(), { contextLimit: 100, reservedTokens: 20, recentRawTokenBudget: 1_000 });
    let calls = 0;
    const harness = new Harness({ history, state: new State(), context, provider: new MockModelProvider(() => { calls += 1; return { content: "must not run" }; }) });
    const result = await harness.send("s", oversized);
    expect(calls).toBe(0);
    expect(result.content).toContain("Context limit reached");
  });
});
