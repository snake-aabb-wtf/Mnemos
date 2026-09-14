import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentRegistry } from "./agents.js";

export const agentTaskStatusSchema = z.enum(["pending", "running", "waiting", "completed", "failed", "cancelled", "blocked"]);
export type AgentTaskStatus = z.infer<typeof agentTaskStatusSchema>;
export const taskFailurePolicySchema = z.enum(["fail-fast", "continue-with-partial"]);
export type TaskFailurePolicy = z.infer<typeof taskFailurePolicySchema>;

export const agentTaskSchema = z.object({
  id: z.string().uuid(),
  parentTaskId: z.string().uuid().optional(),
  sessionId: z.string().min(1),
  createdBy: z.string().min(1),
  assignedAgentId: z.string().min(1).optional(),
  objective: z.string().min(1).max(32_000),
  input: z.record(z.string(), z.unknown()).default({}),
  outputReferences: z.array(z.string()).default([]),
  memoryReferences: z.array(z.string()).default([]),
  artifactReferences: z.array(z.string()).default([]),
  dependencyIds: z.array(z.string().uuid()).default([]),
  status: agentTaskStatusSchema.default("pending"),
  failurePolicy: taskFailurePolicySchema.default("fail-fast"),
  attempt: z.number().int().nonnegative().default(0),
  revision: z.number().int().nonnegative().default(0),
  leaseUntil: z.string().datetime().optional(),
  workerId: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  maxAttempts: z.number().int().positive().default(3),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type AgentTask = z.infer<typeof agentTaskSchema>;

export type AgentTaskInput = Omit<AgentTask, "id" | "createdAt" | "updatedAt" | "revision" | "attempt" | "status" | "leaseUntil" | "workerId"> & {
  id?: string;
  status?: AgentTaskStatus;
};

export interface AgentTaskStore {
  create(task: AgentTask): Promise<AgentTask>;
  get(id: string): Promise<AgentTask | undefined>;
  list(filter?: { sessionId?: string; status?: AgentTaskStatus; parentTaskId?: string }): Promise<readonly AgentTask[]>;
  update(id: string, patch: Partial<AgentTask>, expectedRevision?: number): Promise<AgentTask>;
  claimReady?(workerId: string, now?: Date, leaseMs?: number, sessionId?: string): Promise<AgentTask | undefined>;
  recoverExpired?(now?: Date): Promise<number>;
  close?(): void;
}

export class TaskTransitionError extends Error {
  readonly code = "invalid_task_transition";
}

export class InMemoryAgentTaskStore implements AgentTaskStore {
  private readonly tasks = new Map<string, AgentTask>();
  async create(task: AgentTask): Promise<AgentTask> {
    if (this.tasks.has(task.id)) throw new Error(`Task already exists: ${task.id}`);
    this.tasks.set(task.id, cloneTask(task));
    return cloneTask(task);
  }
  async get(id: string): Promise<AgentTask | undefined> { const task = this.tasks.get(id); return task === undefined ? undefined : cloneTask(task); }
  async list(filter: { sessionId?: string; status?: AgentTaskStatus; parentTaskId?: string } = {}): Promise<readonly AgentTask[]> {
    return [...this.tasks.values()].filter((task) => (filter.sessionId === undefined || task.sessionId === filter.sessionId) && (filter.status === undefined || task.status === filter.status) && (filter.parentTaskId === undefined || task.parentTaskId === filter.parentTaskId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(cloneTask);
  }
  async update(id: string, patch: Partial<AgentTask>, expectedRevision?: number): Promise<AgentTask> {
    const current = this.tasks.get(id);
    if (current === undefined) throw new Error(`Unknown task: ${id}`);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new TaskTransitionError(`Task revision conflict: ${id}`);
    const updated = agentTaskSchema.parse({ ...current, ...patch, revision: current.revision + 1, updatedAt: patch.updatedAt ?? new Date().toISOString() });
    this.tasks.set(id, updated);
    return cloneTask(updated);
  }
  async claimReady(workerId: string, now = new Date(), leaseMs = 30_000, sessionId?: string): Promise<AgentTask | undefined> {
    const nowIso = now.toISOString();
    const candidates = [...this.tasks.values()].filter((task) => (sessionId === undefined || task.sessionId === sessionId) && task.attempt < task.maxAttempts && (task.status === "pending" || task.status === "waiting" || (task.status === "running" && task.leaseUntil !== undefined && task.leaseUntil <= nowIso)) && task.dependencyIds.every((dependencyId) => this.tasks.get(dependencyId)?.status === "completed")).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const candidate = candidates[0];
    if (candidate === undefined) return undefined;
    return this.update(candidate.id, { status: "running", attempt: candidate.attempt + 1, leaseUntil: new Date(now.getTime() + leaseMs).toISOString(), workerId }, candidate.revision);
  }
  async recoverExpired(now = new Date()): Promise<number> {
    const nowIso = now.toISOString();
    let count = 0;
    for (const task of [...this.tasks.values()]) if (task.status === "running" && task.leaseUntil !== undefined && task.leaseUntil <= nowIso) { await this.update(task.id, { status: "pending", leaseUntil: undefined, workerId: undefined }); count += 1; }
    return count;
  }
}

export class TaskManager {
  constructor(private readonly store: AgentTaskStore, private readonly agents?: AgentRegistry, private readonly maxDelegationDepth = 3) {
    if (!Number.isInteger(maxDelegationDepth) || maxDelegationDepth < 0) throw new Error("maxDelegationDepth must be non-negative");
  }
  get taskStore(): AgentTaskStore { return this.store; }

  async create(input: Omit<AgentTaskInput, "createdBy"> & { createdBy: string }): Promise<AgentTask> {
    const parent = input.parentTaskId === undefined ? undefined : await this.require(input.parentTaskId);
    if (parent !== undefined) {
      if (parent.sessionId !== input.sessionId) throw new TaskTransitionError("Child task must share the parent session");
      const depth = await this.depth(parent.id);
      if (depth >= this.maxDelegationDepth) throw new TaskTransitionError("delegation_limit_exceeded");
    }
    if (input.assignedAgentId !== undefined && this.agents?.get(input.assignedAgentId) === undefined) throw new TaskTransitionError("unknown_or_disabled_agent");
    for (const dependencyId of input.dependencyIds) {
      const dependency = await this.store.get(dependencyId);
      if (dependency === undefined || dependency.sessionId !== input.sessionId) throw new TaskTransitionError("invalid_task_dependency");
    }
    const now = new Date().toISOString();
    const task = agentTaskSchema.parse({ ...input, id: input.id ?? randomUUID(), status: input.status ?? "pending", createdAt: now, updatedAt: now, attempt: 0, revision: 0 });
    await this.assertAcyclic(task);
    return this.store.create(task);
  }

  async assign(id: string, agentId: string, expectedRevision?: number): Promise<AgentTask> {
    if (this.agents?.get(agentId) === undefined) throw new TaskTransitionError("unknown_or_disabled_agent");
    const task = await this.require(id);
    if (!["pending", "waiting"].includes(task.status)) throw new TaskTransitionError(`Cannot assign task in ${task.status}`);
    return this.store.update(id, { assignedAgentId: agentId }, expectedRevision ?? task.revision);
  }

  async start(id: string, expectedRevision?: number): Promise<AgentTask> {
    const task = await this.require(id);
    if (task.status === "running") return task;
    if (!["pending", "waiting"].includes(task.status)) throw new TaskTransitionError(`Cannot start task in ${task.status}`);
    const dependencies = await Promise.all(task.dependencyIds.map((dependencyId) => this.require(dependencyId)));
    if (dependencies.some((dependency) => dependency.status === "failed" || dependency.status === "cancelled" || dependency.status === "blocked")) return this.store.update(id, { status: "blocked" }, expectedRevision ?? task.revision);
    if (dependencies.some((dependency) => dependency.status !== "completed")) throw new TaskTransitionError("task_dependencies_incomplete");
    return this.store.update(id, { status: "running", attempt: task.attempt + 1, leaseUntil: undefined, workerId: undefined }, expectedRevision ?? task.revision);
  }

  async complete(id: string, output: Partial<Pick<AgentTask, "outputReferences" | "memoryReferences" | "artifactReferences" | "metadata">> = {}): Promise<AgentTask> {
    const task = await this.require(id);
    if (task.status !== "running") throw new TaskTransitionError(`Cannot complete task in ${task.status}`);
    return this.store.update(id, { ...output, status: "completed", leaseUntil: undefined, workerId: undefined });
  }

  async fail(id: string, metadata: Record<string, unknown> = {}): Promise<AgentTask> {
    const task = await this.require(id);
    if (!["running", "waiting"].includes(task.status)) throw new TaskTransitionError(`Cannot fail task in ${task.status}`);
    return this.store.update(id, { status: task.attempt < task.maxAttempts ? "waiting" : "failed", leaseUntil: undefined, workerId: undefined, metadata: { ...task.metadata, ...metadata } });
  }

  async cancel(id: string, reason = "cancelled"): Promise<AgentTask[]> {
    const root = await this.require(id);
    const descendants = await this.descendants(root.id);
    const cancelled: AgentTask[] = [];
    for (const task of [root, ...descendants]) if (!["completed", "failed", "cancelled"].includes(task.status)) cancelled.push(await this.store.update(task.id, { status: "cancelled", leaseUntil: undefined, workerId: undefined, metadata: { ...task.metadata, cancellationReason: reason } }));
    return cancelled;
  }

  async listChildren(parentTaskId: string): Promise<readonly AgentTask[]> { return this.store.list({ parentTaskId }); }

  async depth(taskId: string): Promise<number> {
    let depth = 0;
    let current = await this.require(taskId);
    while (current.parentTaskId !== undefined) { depth += 1; current = await this.require(current.parentTaskId); }
    return depth;
  }

  private async descendants(parentTaskId: string): Promise<AgentTask[]> {
    const result: AgentTask[] = [];
    const queue = [parentTaskId];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      const children = await this.listChildren(parent);
      result.push(...children);
      queue.push(...children.map((child) => child.id));
    }
    return result;
  }

  private async assertAcyclic(task: AgentTask): Promise<void> {
    const seen = new Set<string>([task.id]);
    const visit = async (id: string): Promise<void> => {
      if (seen.has(id)) throw new TaskTransitionError("task_dependency_cycle");
      seen.add(id);
      const dependency = await this.require(id);
      for (const child of dependency.dependencyIds) await visit(child);
    };
    for (const dependencyId of task.dependencyIds) await visit(dependencyId);
  }

  private async require(id: string): Promise<AgentTask> { const task = await this.store.get(id); if (task === undefined) throw new Error(`Unknown task: ${id}`); return task; }
}

function cloneTask(task: AgentTask): AgentTask { return structuredClone(task); }
