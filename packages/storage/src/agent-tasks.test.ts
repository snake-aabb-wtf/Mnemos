import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry, TaskManager, createBuiltinAgentDefinitions } from "@mnemos/core";
import { SqliteAgentTaskStore } from "./agent-tasks.js";

const directories: string[] = [];
const stores: SqliteAgentTaskStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function database(): Promise<string> { const directory = await mkdtemp(join(tmpdir(), "mnemos-agent-tasks-")); directories.push(directory); return join(directory, "runtime.sqlite"); }
function registry(): AgentRegistry { const value = new AgentRegistry(); for (const definition of createBuiltinAgentDefinitions()) value.register(definition); return value; }

async function task(manager: TaskManager, objective: string, dependencyIds: string[] = []) {
  return manager.create({ sessionId: "s", createdBy: "planner", assignedAgentId: "researcher", objective, input: {}, outputReferences: [], memoryReferences: [], artifactReferences: [], dependencyIds, failurePolicy: "fail-fast", maxAttempts: 3, metadata: {} });
}

describe("Phase 14 durable AgentTask persistence", () => {
  it("atomically claims across worker connections and recovers an expired lease", async () => {
    const path = await database();
    const first = new SqliteAgentTaskStore(path); const second = new SqliteAgentTaskStore(path); stores.push(first, second);
    const manager = new TaskManager(first, registry());
    const created = await task(manager, "research");
    const now = new Date("2026-01-01T00:00:00.000Z");
    const [a, b] = await Promise.all([first.claimReady("a", now, 10), second.claimReady("b", now, 10)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const owner = a ?? b!;
    expect(owner.id).toBe(created.id);
    expect(await first.recoverExpired(new Date(now.getTime() + 11))).toBe(1);
    const recovered = await second.claimReady("b", new Date(now.getTime() + 11), 100);
    expect(recovered?.attempt).toBe(2);
  });

  it("persists task graph, enforces optimistic revisions, and schedules dependencies", async () => {
    const path = await database();
    const first = new SqliteAgentTaskStore(path); stores.push(first);
    const manager = new TaskManager(first, registry());
    const parent = await task(manager, "parent");
    const child = await task(manager, "child", [parent.id]);
    const claimedParent = await first.claimReady("worker", new Date(), 1_000);
    expect(claimedParent?.id).toBe(parent.id);
    await expect(first.update(parent.id, { status: "completed" }, 0)).rejects.toThrow("revision conflict");
    const completed = await first.update(parent.id, { status: "completed" }, claimedParent!.revision);
    expect(completed.status).toBe("completed");
    const claimedChild = await first.claimReady("worker", new Date(), 1_000);
    expect(claimedChild?.id).toBe(child.id);
    first.close(); stores.splice(stores.indexOf(first), 1);
    const reopened = new SqliteAgentTaskStore(path); stores.push(reopened);
    expect((await reopened.get(child.id))?.status).toBe("running");
  });
});
