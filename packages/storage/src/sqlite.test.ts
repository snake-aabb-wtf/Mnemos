import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompactionService, ContextManager, type TokenEstimator } from "@mnemos/core";
import { SqliteContextCompactionStore, SqliteHistoryStore, SqliteStateStore } from "./index.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("SQLite stores", () => {
  it("persists canonical history and isolated mutable state", async () => {
    directory = await mkdtemp(join(tmpdir(), "mnemos-phase-1-"));
    const database = join(directory, "runtime.sqlite");
    const history = new SqliteHistoryStore(database);
    const state = new SqliteStateStore(database);
    const compaction = new SqliteContextCompactionStore(database);

    const first = await history.append({ sessionId: "session-a", role: "user", content: "first" });
    await history.append({ sessionId: "session-a", role: "assistant", content: "second", metadata: { provider: "mock" } });
    await history.append({ sessionId: "session-b", role: "user", content: "other" });
    expect((await history.get("session-a", first.id))?.content).toBe("first");
    expect((await history.list("session-a")).map((entry) => entry.content)).toEqual(["first", "second"]);
    expect((await history.list("session-a", { limit: 1 })).map((entry) => entry.content)).toEqual(["second"]);

    await state.set("session-a", { task: "foundation", count: 1 });
    expect(await state.patch("session-a", { count: 2, complete: true })).toEqual({ task: "foundation", count: 2, complete: true });
    expect(await state.get("session-b")).toBeUndefined();
    await compaction.set({
      sessionId: "session-a",
      evictedThroughMessageId: first.id,
      automaticPin: {
        id: "automatic-compaction",
        sessionId: "session-a",
        source: "automatic",
        content: "# Compacted Context",
        sourceRange: { firstMessageId: first.id, lastMessageId: first.id, messageCount: 1 },
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect((await compaction.get("session-a"))?.automaticPin?.sourceRange?.firstMessageId).toBe(first.id);
    history.close();
    state.close();
    compaction.close();

    const reopened = new SqliteHistoryStore(database);
    expect((await reopened.list("session-a")).map((entry) => entry.content)).toEqual(["first", "second"]);
    reopened.close();

    const reopenedCompaction = new SqliteContextCompactionStore(database);
    expect((await reopenedCompaction.get("session-a"))?.evictedThroughMessageId).toBe(first.id);
    reopenedCompaction.close();
  });

  it("restores a compaction checkpoint without re-evicting canonical history after restart", async () => {
    directory = await mkdtemp(join(tmpdir(), "mnemos-phase-2-"));
    const database = join(directory, "runtime.sqlite");
    const history = new SqliteHistoryStore(database);
    const checkpoints = new SqliteContextCompactionStore(database);
    const records = [];
    for (let turn = 0; turn < 3; turn += 1) {
      records.push(await history.append({ sessionId: "session-a", role: "user", content: `user-${turn}` }));
      records.push(await history.append({ sessionId: "session-a", role: "assistant", content: `assistant-${turn}` }));
    }
    const estimator: TokenEstimator = { estimateText: (text) => Math.ceil(text.length / 4), estimateMessage: () => 10 };
    const manager = new ContextManager(estimator, {
      contextLimit: 100,
      reservedTokens: 10,
      recentRawTokenBudget: 40,
      pinnedTokenBudget: 30,
    });
    const firstService = new CompactionService({ history, checkpoints, context: manager, cutoffSearchWindowTokens: 10 });
    const first = await firstService.prepare("session-a");
    expect(first.evictions).toHaveLength(1);
    expect(first.evictions[0].evictedMessageIds).toEqual([records[0].id, records[1].id]);
    history.close();
    checkpoints.close();

    const reopenedHistory = new SqliteHistoryStore(database);
    const reopenedCheckpoints = new SqliteContextCompactionStore(database);
    const restartedManager = new ContextManager(estimator, {
      contextLimit: 100,
      reservedTokens: 10,
      recentRawTokenBudget: 40,
      pinnedTokenBudget: 30,
    });
    const restartedService = new CompactionService({
      history: reopenedHistory,
      checkpoints: reopenedCheckpoints,
      context: restartedManager,
      cutoffSearchWindowTokens: 10,
    });
    const afterRestart = await restartedService.prepare("session-a");
    expect(afterRestart.evictions).toHaveLength(0);
    expect(afterRestart.context.pinned[0].sourceRange?.lastMessageId).toBe(records[1].id);
    expect((await reopenedHistory.get("session-a", records[0].id))?.content).toBe("user-0");
    expect((await reopenedHistory.list("session-a"))).toHaveLength(6);
    reopenedHistory.close();
    reopenedCheckpoints.close();
  });
});
