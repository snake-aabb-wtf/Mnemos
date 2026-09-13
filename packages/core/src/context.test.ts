import { describe, expect, it } from "vitest";
import { CharacterTokenEstimator, ContextManager, type HistoryMessage } from "./index.js";

const message = (id: string, content: string): HistoryMessage => ({
  id: `00000000-0000-4000-8000-${id.padStart(12, "0")}`,
  sessionId: "session",
  role: "user",
  content,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("ContextManager", () => {
  it("keeps the newest complete messages within the configured raw budget", () => {
    const manager = new ContextManager(new CharacterTokenEstimator(), {
      recentRawTokenBudget: 13,
      contextLimit: 100,
      reservedTokens: 10,
    });
    const context = manager.build([message("1", "aaaa"), message("2", "bbbb"), message("3", "cccc")]);

    expect(context.recentMessages.map((entry) => entry.id)).toEqual([
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ]);
    expect(context.stats.recentRawTokens).toBe(10);
  });

  it("enforces the pinned-context budget without mutating existing pins", () => {
    const manager = new ContextManager(new CharacterTokenEstimator(), {
      pinnedTokenBudget: 1,
      contextLimit: 100,
      reservedTokens: 10,
    });
    manager.addPin({ id: "goal", content: "abcd", source: "system" });
    expect(() => manager.addPin({ id: "decision", content: "abcd", source: "automatic" })).toThrow(/Pinned context/);
    expect(manager.listPins().map((pin) => pin.id)).toEqual(["goal"]);
  });
});
