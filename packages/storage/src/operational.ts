import { access, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SqliteArtifactStore } from "./artifact.js";
import { SqliteDurableJobQueue } from "./job-queue.js";
import { SqliteMigrationRunner, type SqliteMigration } from "./migrations.js";
import type { AgentRegistry, AgentTaskStore } from "@mnemos/core";

export interface DoctorCheck { name: string; status: "OK" | "WARN" | "ERROR"; detail: string; }
export interface DoctorReport { status: "OK" | "WARN" | "ERROR"; checks: readonly DoctorCheck[]; schemaVersion: number; }

export interface OperationalOptions { databasePath: string; artifactDirectory: string; migrations?: readonly SqliteMigration[]; agents?: AgentRegistry; agentTasks?: AgentTaskStore; }

export async function runDoctor(options: OperationalOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const migrations = new SqliteMigrationRunner(options.databasePath);
  let schemaVersion = 0;
  try {
    schemaVersion = migrations.currentVersion();
    checks.push({ name: "database", status: "OK", detail: `SQLite available; schema version ${schemaVersion}` });
    if (options.migrations) {
      try { migrations.run(options.migrations); schemaVersion = migrations.currentVersion(); checks.push({ name: "migrations", status: "OK", detail: `schema version ${schemaVersion}` }); }
      catch (error) { checks.push({ name: "migrations", status: "ERROR", detail: error instanceof Error ? error.message : "migration failed" }); }
    }
  } finally { migrations.close(); }
  try {
    await access(options.artifactDirectory);
    const entries = await readdir(options.artifactDirectory);
    checks.push({ name: "artifact-directory", status: "OK", detail: `${entries.length} entries` });
  } catch { checks.push({ name: "artifact-directory", status: "WARN", detail: "artifact directory is not present yet" }); }
  try {
    const artifactStore = new SqliteArtifactStore({ databasePath: options.databasePath, storageDirectory: options.artifactDirectory });
    const recovery = await artifactStore.recoverOrphans();
    artifactStore.close();
    checks.push({ name: "artifacts", status: recovery.missingBodyIds.length > 0 ? "WARN" : "OK", detail: `${recovery.missingBodyIds.length} missing bodies; ${recovery.deletedOrphanLocations.length} orphans removed` });
  } catch (error) { checks.push({ name: "artifacts", status: "ERROR", detail: error instanceof Error ? error.message : "artifact check failed" }); }
  try {
    const queue = new SqliteDurableJobQueue(options.databasePath);
    const pending = (await queue.list("pending")).length;
    queue.close();
    checks.push({ name: "job-queue", status: "OK", detail: `${pending} pending jobs` });
  } catch (error) { checks.push({ name: "job-queue", status: "ERROR", detail: error instanceof Error ? error.message : "queue check failed" }); }
  if (options.agents !== undefined) {
    const definitions = options.agents.list({ includeDisabled: true });
    checks.push({ name: "agent-registry", status: "OK", detail: `${definitions.length} definitions (${definitions.filter((definition) => options.agents!.get(definition.id) !== undefined).length} enabled)` });
  }
  if (options.agentTasks !== undefined) {
    try {
      const tasks = await options.agentTasks.list();
      checks.push({ name: "agent-tasks", status: "OK", detail: `${tasks.length} persisted tasks; ${tasks.filter((task) => task.status === "blocked").length} blocked` });
    } catch (error) { checks.push({ name: "agent-tasks", status: "ERROR", detail: error instanceof Error ? error.message : "agent task check failed" }); }
  }
  const status = checks.some((check) => check.status === "ERROR") ? "ERROR" : checks.some((check) => check.status === "WARN") ? "WARN" : "OK";
  return { status, checks, schemaVersion };
}

export async function storageDiagnostics(options: OperationalOptions): Promise<{ databasePath: string; artifactDirectory: string; databaseBytes: number; artifactBytes: number; schemaVersion: number; agentTaskCounts?: Record<string, number> }> {
  const migrations = new SqliteMigrationRunner(options.databasePath);
  const schemaVersion = migrations.currentVersion();
  migrations.close();
  const databaseBytes = await stat(options.databasePath).then((info) => info.size).catch(() => 0);
  const artifactBytes = await directoryBytes(options.artifactDirectory);
  if (options.agentTasks === undefined) return { databasePath: options.databasePath, artifactDirectory: options.artifactDirectory, databaseBytes, artifactBytes, schemaVersion };
  const taskCounts: Record<string, number> = {};
  for (const task of await options.agentTasks.list()) taskCounts[task.status] = (taskCounts[task.status] ?? 0) + 1;
  return { databasePath: options.databasePath, artifactDirectory: options.artifactDirectory, databaseBytes, artifactBytes, schemaVersion, agentTaskCounts: taskCounts };
}

async function directoryBytes(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    const path = join(directory, entry.name);
    total += entry.isDirectory() ? await directoryBytes(path) : await stat(path).then((info) => info.size).catch(() => 0);
  }
  return total;
}
