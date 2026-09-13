import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteHistoryStore, SqliteStateStore } from "./index.js";

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

    const first = await history.append({ sessionId: "session-a", role: "user", content: "first" });
    await history.append({ sessionId: "session-a", role: "assistant", content: "second", metadata: { provider: "mock" } });
    await history.append({ sessionId: "session-b", role: "user", content: "other" });
    expect((await history.get("session-a", first.id))?.content).toBe("first");
    expect((await history.list("session-a")).map((entry) => entry.content)).toEqual(["first", "second"]);
    expect((await history.list("session-a", { limit: 1 })).map((entry) => entry.content)).toEqual(["second"]);

    await state.set("session-a", { task: "foundation", count: 1 });
    expect(await state.patch("session-a", { count: 2, complete: true })).toEqual({ task: "foundation", count: 2, complete: true });
    expect(await state.get("session-b")).toBeUndefined();
    history.close();
    state.close();

    const reopened = new SqliteHistoryStore(database);
    expect((await reopened.list("session-a")).map((entry) => entry.content)).toEqual(["first", "second"]);
    reopened.close();
  });
});
