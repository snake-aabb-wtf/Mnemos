import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableWorker } from "@mnemos/core";
import { SqliteToolAuditStore } from "./audit.js";
import { SqliteDurableJobQueue } from "./job-queue.js";
import { SqliteMigrationRunner } from "./migrations.js";
import { runDoctor, storageDiagnostics } from "./operational.js";

const directories: string[] = [];
const closers: Array<() => void> = [];
afterEach(async () => { for (const close of closers.splice(0)) close(); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function database(prefix = "mnemos-production-"): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), prefix)); directories.push(directory); return { directory, path: join(directory, "runtime.sqlite") };
}

describe("Phase 13 production persistence", () => {
  it("claims jobs atomically, recovers expired leases, and prevents cross-worker completion", async () => {
    const { path } = await database();
    const first = new SqliteDurableJobQueue<{ value: number }>(path);
    const second = new SqliteDurableJobQueue<{ value: number }>(path);
    closers.push(() => first.close(), () => second.close());
    const job = await first.enqueue("test", { value: 1 }, { maxAttempts: 3 });
    const claimTime = new Date();
    const [a, b] = await Promise.all([first.claim("worker-a", claimTime, 100), second.claim("worker-b", claimTime, 100)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const owner = a ?? b!;
    const wrong = owner.workerId === "worker-a" ? "worker-b" : "worker-a";
    await expect(first.complete(owner.id, wrong)).rejects.toThrow("not owned");
    const expiredAt = new Date(claimTime.getTime() + 101);
    expect(await first.recoverExpired(expiredAt)).toBe(1);
    const recovered = await second.claim(wrong, expiredAt, 100);
    expect(recovered?.attempts).toBe(2);
    await second.complete(recovered!.id, wrong);
    expect((await first.list("completed"))).toHaveLength(1);
  });

  it("runs a bounded worker and leaves failed jobs retryable", async () => {
    const { path } = await database("mnemos-worker-");
    const queue = new SqliteDurableJobQueue<{ index: number }>(path); closers.push(() => queue.close());
    for (let index = 0; index < 12; index += 1) await queue.enqueue("work", { index }, { maxAttempts: 2 });
    const handled: number[] = [];
    const worker = new DurableWorker(queue, async (job) => { handled.push(job.payload.index); if (job.payload.index === 3 && job.attempts === 1) throw new Error("retry once"); }, { workerId: "worker", concurrency: 3, pollIntervalMs: 1, leaseMs: 1_000, maxAttempts: 2 });
    await worker.start();
    const deadline = Date.now() + 5_000;
    while ((await queue.list("completed")).length < 12 && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 10)); }
    await worker.stop(1_000);
    expect((await queue.list("completed"))).toHaveLength(12);
    expect(handled.filter((index) => index === 3)).toHaveLength(2);
    expect(worker.activeCount).toBe(0);
  });

  it("supports independent worker connections without duplicate claims", async () => {
    const { path } = await database("mnemos-workers-");
    const queues = Array.from({ length: 4 }, () => new SqliteDurableJobQueue<{ index: number }>(path));
    closers.push(...queues.map((queue) => () => queue.close()));
    for (let index = 0; index < 64; index += 1) await queues[0]!.enqueue("parallel", { index });
    const processed: number[] = [];
    await Promise.all(queues.map(async (queue, workerIndex) => {
      for (;;) {
        const job = await queue.claim(`worker-${workerIndex}`, new Date(), 5_000);
        if (!job) break;
        processed.push(job.payload.index);
        await queue.complete(job.id, `worker-${workerIndex}`);
      }
    }));
    expect(processed).toHaveLength(64);
    expect(new Set(processed).size).toBe(64);
  });

  it("persists compact tool audit with retention and survives reopen", async () => {
    const { path } = await database("mnemos-audit-");
    const audit = new SqliteToolAuditStore(path); closers.push(() => audit.close());
    await audit.append({ callId: "call-1", toolName: "memory.search", sessionId: "s", agentId: "a", principal: "p", startedAt: "2026-01-01T00:00:00.000Z", durationMs: 3, status: "success", outputKind: "inline" });
    await audit.append({ callId: "call-2", toolName: "state.patch", sessionId: "s", agentId: "a", principal: "p", startedAt: "2026-01-02T00:00:00.000Z", durationMs: 4, status: "denied", errorCode: "permission_denied" });
    expect(await audit.list({ sessionId: "s", limit: 10 })).toHaveLength(2);
    expect(await audit.cleanup({ maxRows: 1 })).toBe(1);
    expect(audit.count()).toBe(1);
  });

  it("applies monotonic migrations transactionally and reports safe diagnostics", async () => {
    const { directory, path } = await database("mnemos-migrations-");
    const backups: string[] = [];
    const migrations = new SqliteMigrationRunner(path, { beforeMigration: (_db, fromVersion, toVersion) => backups.push(`${fromVersion}->${toVersion}`) }); closers.push(() => migrations.close());
    expect(migrations.run([{ version: 1, name: "one", up: (db) => { db.exec("CREATE TABLE reliability_marker (value TEXT NOT NULL)"); } }, { version: 2, name: "two", up: (db) => { db.exec("ALTER TABLE reliability_marker ADD COLUMN second INTEGER NOT NULL DEFAULT 0"); } }])).toBe(2);
    expect(migrations.run([{ version: 1, name: "one", up: () => { throw new Error("must not rerun"); } }, { version: 2, name: "two", up: () => { throw new Error("must not rerun"); } }])).toBe(2);
    expect(migrations.list()).toHaveLength(2);
    expect(backups).toEqual(["0->1", "1->2"]);
    const report = await runDoctor({ databasePath: path, artifactDirectory: join(directory, "artifacts") });
    expect(report.status).toBe("WARN");
    const diagnostics = await storageDiagnostics({ databasePath: path, artifactDirectory: join(directory, "artifacts") });
    expect(diagnostics.schemaVersion).toBe(2);
  });
});
