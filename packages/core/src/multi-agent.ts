import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AgentRegistry, AgentRuntime, type AgentDefinition, type AgentBudget, intersectPermissions } from "./agents.js";
import { ContextManager, CharacterTokenEstimator } from "./context.js";
import type { EventBus, HarnessEventMap } from "./events.js";
import { InMemoryAgentTaskStore, TaskManager, type AgentTask, type AgentTaskInput, type AgentTaskStore, type TaskFailurePolicy } from "./tasks.js";
import type { ModelProvider, ModelResponse } from "./model.js";
import type { MetricsSink, Tracer } from "./observability.js";
import type { MemorySearchQuery, MemoryType } from "./memory.js";
import { hiddenMemoryCandidateSchema, type MemoryRememberRequest } from "./consolidation.js";

export type AgentArtifactVisibility = "private" | "task" | "session" | "shared";
export interface AgentArtifactRegistration { handleId: string; ownerAgentId: string; taskId: string; sessionId: string; visibility: AgentArtifactVisibility; }

/** Lightweight ACL projection over the shared ArtifactStore; bodies remain in ArtifactStore. */
export class AgentArtifactWorkspace {
  private readonly registrations = new Map<string, AgentArtifactRegistration>();
  register(registration: AgentArtifactRegistration): void { this.registrations.set(registration.handleId, { ...registration }); }
  canRead(handleId: string, agentId: string, taskId: string, sessionId: string): boolean {
    const registration = this.registrations.get(handleId);
    if (registration === undefined) return false;
    return registration.visibility === "shared" || registration.ownerAgentId === agentId || (registration.visibility === "task" && registration.taskId === taskId) || (registration.visibility === "session" && registration.sessionId === sessionId);
  }
  readable(handles: readonly string[], agentId: string, taskId: string, sessionId: string): string[] { return handles.filter((handle) => this.canRead(handle, agentId, taskId, sessionId)); }
  list(): readonly AgentArtifactRegistration[] { return [...this.registrations.values()].map((registration) => ({ ...registration })); }
}

export const structuredAgentOutputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("result"), summary: z.string().max(64_000), artifactRefs: z.array(z.string()).default([]), memoryRefs: z.array(z.string()).default([]), output: z.record(z.string(), z.unknown()).default({}) }).strict(),
  z.object({ kind: z.literal("plan"), summary: z.string().max(64_000), tasks: z.array(z.object({ agentId: z.string().min(1), objective: z.string().min(1).max(32_000), dependencies: z.array(z.number().int().nonnegative()).default([]), input: z.record(z.string(), z.unknown()).default({}), failurePolicy: z.enum(["fail-fast", "continue-with-partial"]).default("fail-fast") }).strict()).max(128) }).strict(),
  z.object({ kind: z.literal("review"), decision: z.enum(["approve", "reject"]), summary: z.string().max(64_000), issues: z.array(z.string().max(4_096)).max(100).default([]), artifactRefs: z.array(z.string()).default([]) }).strict(),
  z.object({ kind: z.literal("delegate"), agentId: z.string().min(1), objective: z.string().min(1).max(32_000), input: z.record(z.string(), z.unknown()).default({}) }).strict(),
]);
export type StructuredAgentOutput = z.infer<typeof structuredAgentOutputSchema>;

export const agentMessageSchema = z.object({
  id: z.string().uuid(),
  senderAgentId: z.string().min(1),
  receiverAgentId: z.string().min(1),
  taskId: z.string().uuid(),
  objective: z.string().min(1).max(32_000),
  content: z.string().max(32_000),
  artifactRefs: z.array(z.string()).max(128).default([]),
  memoryRefs: z.array(z.string()).max(128).default([]),
  tokenEstimate: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
}).strict();
export type AgentMessage = z.infer<typeof agentMessageSchema>;

export interface RoleMemoryPolicy { types?: readonly MemoryType[]; preferredTags?: readonly string[]; includeHistorical?: boolean; }
export const defaultRoleMemoryPolicies: Readonly<Record<string, RoleMemoryPolicy>> = {
  planner: { types: ["decision", "semantic", "entity"] },
  researcher: { types: ["semantic", "episodic", "entity"], includeHistorical: true },
  coder: { types: ["semantic", "decision", "entity"] },
  reviewer: { types: ["decision", "semantic", "episodic"] },
  visible: { types: ["decision", "semantic", "preference", "entity"] },
};

/** Role-aware retrieval only narrows the shared MemoryRetriever contract; it never writes Memory. */
export function memoryQueryForAgent(role: string, query: MemorySearchQuery, policy: RoleMemoryPolicy = defaultRoleMemoryPolicies[role] ?? {}): MemorySearchQuery {
  const allowedTypes = policy.types === undefined ? query.types : query.types === undefined ? [...policy.types] : query.types.filter((type) => policy.types!.includes(type));
  return { ...query, ...(allowedTypes === undefined || allowedTypes.length === 0 ? {} : { types: allowedTypes }) };
}

export function agentCanUseTool(definition: AgentDefinition, toolName: string): boolean {
  const namespace = toolName.split(".")[0] ?? toolName;
  return definition.toolPolicy.allowedNamespaces.includes(namespace) || definition.toolPolicy.coreTools.includes(toolName) || definition.toolPolicy.coreTools.includes("*");
}

export interface HandoffContextInput {
  task: AgentTask;
  senderAgentId: string;
  receiver: AgentDefinition;
  summary?: string;
  artifactRefs?: readonly string[];
  memoryRefs?: readonly string[];
  sharedState?: Record<string, unknown>;
}

export interface HandoffContext {
  objective: string;
  summary: string;
  artifactRefs: readonly string[];
  memoryRefs: readonly string[];
  sharedState: Record<string, unknown>;
  tokenEstimate: number;
  byteLength: number;
}

export class HandoffContextBuilder {
  private readonly estimator = new CharacterTokenEstimator();
  constructor(private readonly maxTokens = 4_000, private readonly maxBytes = 32_000) {
    if (maxTokens < 1 || maxBytes < 1) throw new Error("Handoff limits must be positive");
  }
  build(input: HandoffContextInput): HandoffContext {
    const summary = truncateUtf8(input.summary ?? "", Math.min(this.maxBytes, this.maxTokens * 4));
    const artifactRefs = [...new Set(input.artifactRefs ?? [])].slice(0, 128);
    const memoryRefs = [...new Set(input.memoryRefs ?? [])].slice(0, 128);
    const sharedState = input.sharedState ?? {};
    let result = { objective: input.task.objective, summary, artifactRefs, memoryRefs, sharedState };
    let serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized) > this.maxBytes) {
      result = { ...result, sharedState: {}, summary: truncateUtf8(summary, Math.max(0, this.maxBytes - Buffer.byteLength(JSON.stringify({ ...result, sharedState: {}, summary: "" })))) };
      serialized = JSON.stringify(result);
    }
    const tokenEstimate = this.estimator.estimateText(serialized);
    if (tokenEstimate > this.maxTokens) {
      result = { ...result, summary: truncateUtf8(result.summary, Math.max(0, this.maxTokens * 4 - Buffer.byteLength(JSON.stringify({ ...result, summary: "" })))) };
      serialized = JSON.stringify(result);
    }
    return { ...result, tokenEstimate: this.estimator.estimateText(serialized), byteLength: Buffer.byteLength(serialized) };
  }
}

export interface SharedTaskState {
  revision: number;
  value: Record<string, unknown>;
}

export interface SharedTaskStateStore {
  get(taskId: string): Promise<SharedTaskState | undefined>;
  set(taskId: string, value: Record<string, unknown>, expectedRevision?: number): Promise<SharedTaskState>;
}

export class InMemorySharedTaskStateStore implements SharedTaskStateStore {
  private readonly values = new Map<string, SharedTaskState>();
  async get(taskId: string): Promise<SharedTaskState | undefined> { const value = this.values.get(taskId); return value === undefined ? undefined : structuredClone(value); }
  async set(taskId: string, value: Record<string, unknown>, expectedRevision?: number): Promise<SharedTaskState> {
    const current = this.values.get(taskId);
    if (expectedRevision !== undefined && (current?.revision ?? 0) !== expectedRevision) throw new Error("shared_state_conflict");
    const next = { revision: (current?.revision ?? 0) + 1, value: structuredClone(value) };
    this.values.set(taskId, next);
    return structuredClone(next);
  }
}

export interface MultiAgentOrchestratorOptions {
  registry: AgentRegistry;
  taskManager?: TaskManager;
  taskStore?: AgentTaskStore;
  providers: ReadonlyMap<string, ModelProvider> | Record<string, ModelProvider>;
  defaultProvider?: ModelProvider;
  hostPermissions?: readonly string[];
  maxConcurrentAgents?: number;
  maxConcurrentAgentsPerSession?: number;
  maxDelegationDepth?: number;
  maxChildTasks?: number;
  maxReviewIterations?: number;
  maxReplans?: number;
  handoffContext?: HandoffContextBuilder;
  sharedState?: SharedTaskStateStore;
  events?: EventBus<HarnessEventMap>;
  metrics?: MetricsSink;
  tracer?: Tracer;
  artifactWorkspace?: AgentArtifactWorkspace;
  submitMemoryCandidate?: (request: MemoryRememberRequest) => Promise<unknown>;
  toolInvoker?: (request: { agentId: string; sessionId: string; taskId: string; permissions: readonly string[]; toolName: string; arguments: unknown }) => Promise<unknown>;
  now?: () => Date;
}

export interface MultiAgentRunResult {
  rootTask: AgentTask;
  tasks: readonly AgentTask[];
  messages: readonly AgentMessage[];
  status: "completed" | "failed" | "partial" | "cancelled";
}

export interface MultiAgentDiagnostics {
  registeredAgents: number;
  activeAgents: number;
  taskCounts: Record<AgentTask["status"], number>;
  delegationDepth: number;
  handoffCount: number;
}

export class MultiAgentOrchestrator {
  readonly registry: AgentRegistry;
  readonly taskManager: TaskManager;
  readonly messages: AgentMessage[] = [];
  readonly sharedState: SharedTaskStateStore;
  private readonly providers: ReadonlyMap<string, ModelProvider>;
  private readonly defaultProvider?: ModelProvider;
  private readonly hostPermissions: readonly string[];
  private readonly maxConcurrentAgents: number;
  private readonly maxConcurrentAgentsPerSession: number;
  private readonly maxChildTasks: number;
  private readonly maxReviewIterations: number;
  private readonly maxReplans: number;
  private readonly handoffBuilder: HandoffContextBuilder;
  private readonly events?: EventBus<HarnessEventMap>;
  private readonly metrics?: MetricsSink;
  private readonly tracer?: Tracer;
  private readonly now: () => Date;
  private readonly artifactWorkspace?: AgentArtifactWorkspace;
  private readonly memoryCandidateSink?: (request: MemoryRememberRequest) => Promise<unknown>;
  private readonly toolInvoker?: MultiAgentOrchestratorOptions["toolInvoker"];
  private readonly workerId = `agent-orchestrator-${randomUUID()}`;
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly reviewCounts = new Map<string, number>();
  private readonly replanCounts = new Map<string, number>();
  private readonly childBudgets = new Map<string, AgentBudget>();

  constructor(options: MultiAgentOrchestratorOptions) {
    this.registry = options.registry;
    const store = options.taskStore ?? new InMemoryAgentTaskStore();
    this.taskManager = options.taskManager ?? new TaskManager(store, this.registry, options.maxDelegationDepth ?? 3);
    this.providers = options.providers instanceof Map ? options.providers : new Map(Object.entries(options.providers));
    this.defaultProvider = options.defaultProvider;
    this.hostPermissions = [...new Set(options.hostPermissions ?? [])];
    this.maxConcurrentAgents = positive(options.maxConcurrentAgents ?? 4, "maxConcurrentAgents");
    this.maxConcurrentAgentsPerSession = positive(options.maxConcurrentAgentsPerSession ?? 4, "maxConcurrentAgentsPerSession");
    this.maxChildTasks = positiveOrZero(options.maxChildTasks ?? 8, "maxChildTasks");
    this.maxReviewIterations = positiveOrZero(options.maxReviewIterations ?? 2, "maxReviewIterations");
    this.maxReplans = positiveOrZero(options.maxReplans ?? 2, "maxReplans");
    this.handoffBuilder = options.handoffContext ?? new HandoffContextBuilder();
    this.sharedState = options.sharedState ?? new InMemorySharedTaskStateStore();
    this.events = options.events;
    this.metrics = options.metrics;
    this.tracer = options.tracer;
    this.now = options.now ?? (() => new Date());
    this.artifactWorkspace = options.artifactWorkspace;
    this.memoryCandidateSink = options.submitMemoryCandidate;
    this.toolInvoker = options.toolInvoker;
  }

  async createRoot(input: { sessionId: string; objective: string; agentId: string; createdBy?: string; input?: Record<string, unknown>; failurePolicy?: TaskFailurePolicy }): Promise<AgentTask> {
    const definition = this.requireDefinition(input.agentId);
    const permissions = intersectPermissions(this.hostPermissions.length === 0 ? definition.permissions : this.hostPermissions, definition.permissions);
    if (permissions.length === 0 && definition.permissions.length > 0 && this.hostPermissions.length > 0) throw new Error("root_agent_permission_denied");
    const task = await this.taskManager.create({ sessionId: input.sessionId, createdBy: input.createdBy ?? "host", assignedAgentId: definition.id, objective: input.objective, input: input.input ?? {}, outputReferences: [], memoryReferences: [], artifactReferences: [], dependencyIds: [], failurePolicy: input.failurePolicy ?? "fail-fast", maxAttempts: 3, metadata: { root: true, effectivePermissions: permissions } });
    await this.sharedState.set(task.id, { objective: input.objective, status: "created" });
    return task;
  }

  async delegate(parent: AgentRuntime, input: { agentId: string; objective: string; input?: Record<string, unknown>; dependencyIds?: readonly string[]; failurePolicy?: TaskFailurePolicy; budget?: Partial<AgentBudget> }): Promise<AgentTask> {
    await this.assertRuntimeAuthority(parent);
    const definition = this.requireDefinition(input.agentId);
    if (parent.budget.usage.childTasks >= parent.budget.allocation.maxChildTasks) throw new Error("child_task_limit_exceeded");
    if (await this.taskManager.listChildren(parent.taskId).then((children) => children.length >= this.maxChildTasks)) throw new Error("child_task_limit_exceeded");
    const childBudget = parent.budget.reserveChild(input.budget);
    const effectivePermissions = intersectPermissions(parent.permissions, definition.permissions);
    const childTask = await this.taskManager.create({ sessionId: parent.sessionId, parentTaskId: parent.taskId, createdBy: parent.definition.id, assignedAgentId: definition.id, objective: input.objective, input: input.input ?? {}, outputReferences: [], memoryReferences: [], artifactReferences: [], dependencyIds: [...(input.dependencyIds ?? [])], failurePolicy: input.failurePolicy ?? "fail-fast", maxAttempts: 3, metadata: { delegatedBy: parent.definition.id, effectivePermissions } });
    this.childBudgets.set(childTask.id, childBudget);
    parent.budget.consume("childTasks", 1);
    await this.events?.emit("task.created", { taskId: childTask.id, parentTaskId: parent.taskId, agentId: definition.id, sessionId: childTask.sessionId });
    return childTask;
  }

  async handoff(sender: AgentRuntime, receiverAgentId: string, task: AgentTask, content: { summary?: string; artifactRefs?: readonly string[]; memoryRefs?: readonly string[] }): Promise<AgentMessage> {
    await this.assertRuntimeAuthority(sender);
    if (sender.sessionId !== task.sessionId) throw new Error("handoff_session_mismatch");
    const receiver = this.requireDefinition(receiverAgentId);
    const readableArtifacts = this.artifactWorkspace === undefined ? [...(content.artifactRefs ?? [])] : this.artifactWorkspace.readable(content.artifactRefs ?? [], receiverAgentId, task.id, task.sessionId);
    const context = this.handoffBuilder.build({ task, senderAgentId: sender.definition.id, receiver, summary: content.summary, artifactRefs: readableArtifacts, memoryRefs: content.memoryRefs, sharedState: (await this.sharedState.get(task.id))?.value });
    const message = agentMessageSchema.parse({ id: randomUUID(), senderAgentId: sender.definition.id, receiverAgentId, taskId: task.id, objective: task.objective, content: context.summary, artifactRefs: context.artifactRefs, memoryRefs: context.memoryRefs, tokenEstimate: context.tokenEstimate, createdAt: this.now().toISOString() });
    this.messages.push(message);
    await this.events?.emit("agent.handoff", { messageId: message.id, taskId: task.id, senderAgentId: message.senderAgentId, receiverAgentId: message.receiverAgentId, tokenEstimate: message.tokenEstimate, artifactCount: message.artifactRefs.length, memoryCount: message.memoryRefs.length });
    this.metrics?.increment("agent.handoffs");
    return message;
  }

  async run(rootTaskId: string): Promise<MultiAgentRunResult> {
    const root = await this.requireTask(rootTaskId);
    const rootController = new AbortController();
    this.controllers.set(root.id, rootController);
    try {
      for (;;) {
        const tasks = await this.taskManager.taskStore.list({ sessionId: root.sessionId });
        // A fail-fast dependent is not runnable once any prerequisite has
        // failed/cancelled/blocked. Mark it explicitly so the graph reaches a
        // terminal state and diagnostics do not report a leaked pending task.
        for (const task of tasks) {
          if (!["pending", "waiting"].includes(task.status) || task.failurePolicy !== "fail-fast") continue;
          const failedDependency = task.dependencyIds.some((dependencyId) => {
            const dependency = tasks.find((candidate) => candidate.id === dependencyId);
            return dependency !== undefined && ["failed", "cancelled", "blocked"].includes(dependency.status);
          });
          if (failedDependency) await this.taskManager.taskStore.update(task.id, { status: "blocked", metadata: { ...task.metadata, blockedReason: "dependency_failed" } }, task.revision);
        }
        const refreshedTasks = await this.taskManager.taskStore.list({ sessionId: root.sessionId });
        const ready = refreshedTasks.filter((task) => (task.status === "pending" || task.status === "waiting") && this.dependenciesReady(task, refreshedTasks));
        const terminal = refreshedTasks.every((task) => ["completed", "failed", "cancelled", "blocked"].includes(task.status));
        if (terminal && ready.length === 0) break;
        if (ready.length === 0) {
          if (refreshedTasks.some((task) => task.status === "running")) { await new Promise((resolve) => setTimeout(resolve, 1)); continue; }
          break;
        }
        const batch: AgentTask[] = [];
        const sessionCounts = new Map<string, number>();
        if (this.taskManager.taskStore.claimReady !== undefined) {
          while (batch.length < this.maxConcurrentAgents) {
            if ((sessionCounts.get(root.sessionId) ?? 0) >= this.maxConcurrentAgentsPerSession) break;
            const claimed = await this.taskManager.taskStore.claimReady(this.workerId, this.now(), 30_000, root.sessionId);
            if (claimed === undefined) break;
            batch.push(claimed); sessionCounts.set(claimed.sessionId, (sessionCounts.get(claimed.sessionId) ?? 0) + 1);
          }
        }
        if (batch.length === 0 && this.taskManager.taskStore.claimReady === undefined) {
        for (const task of ready) {
          if (batch.length >= this.maxConcurrentAgents) break;
          if ((sessionCounts.get(task.sessionId) ?? 0) >= this.maxConcurrentAgentsPerSession) continue;
          if (this.activeCount() >= this.maxConcurrentAgents) break;
          batch.push(task); sessionCounts.set(task.sessionId, (sessionCounts.get(task.sessionId) ?? 0) + 1);
        }
        }
        if (batch.length === 0) { await new Promise((resolve) => setTimeout(resolve, 1)); continue; }
        await Promise.all(batch.map((task) => this.executeTask(task, rootController.signal)));
      }
      const finalTasks = await this.taskManager.taskStore.list({ sessionId: root.sessionId });
      const finalRoot = await this.requireTask(root.id);
      const status = finalRoot.status === "completed" ? (finalTasks.some((task) => task.status === "failed") ? "partial" : "completed") : finalRoot.status === "cancelled" ? "cancelled" : "failed";
      return { rootTask: finalRoot, tasks: finalTasks, messages: [...this.messages], status };
    } finally { this.controllers.delete(root.id); }
  }

  async cancel(taskId: string): Promise<readonly AgentTask[]> {
    this.controllers.get(taskId)?.abort();
    const runtime = this.runtimes.get(taskId); runtime?.cancel();
    const cancelled = await this.taskManager.cancel(taskId, "cascade_cancelled");
    for (const task of cancelled) {
      this.controllers.get(task.id)?.abort();
      await this.events?.emit("task.cancelled", { taskId: task.id, sessionId: task.sessionId, reason: "cascade_cancelled" });
    }
    return cancelled;
  }

  getRuntime(taskId: string): AgentRuntime | undefined { return this.runtimes.get(taskId); }

  /** Agent conclusions enter the existing Hidden-Agent candidate pipeline and are never direct Memory writes. */
  async submitMemoryCandidate(runtime: AgentRuntime, candidate: unknown): Promise<unknown> {
    await this.assertRuntimeAuthority(runtime);
    if (this.memoryCandidateSink === undefined) throw new Error("memory_pipeline_not_configured");
    const parsed = hiddenMemoryCandidateSchema.parse(candidate);
    const grounded = { ...parsed, sourceType: "assistant_inference" as const, status: "provisional" as const, sourceReferences: parsed.sourceReferences.filter((source) => source.sessionId === runtime.sessionId) };
    if (grounded.sourceReferences.length === 0) throw new Error("memory_candidate_scope_violation");
    return this.memoryCandidateSink({ sessionId: runtime.sessionId, candidate: grounded });
  }

  async invokeTool(runtime: AgentRuntime, toolName: string, argumentsValue: unknown): Promise<unknown> {
    await this.assertRuntimeAuthority(runtime);
    const definition = this.requireDefinition(runtime.definition.id);
    if (!agentCanUseTool(definition, toolName)) throw new Error("agent_tool_not_exposed");
    if (this.toolInvoker === undefined) throw new Error("tool_runtime_not_configured");
    runtime.budget.consume("toolCalls");
    return this.toolInvoker({ agentId: runtime.definition.id, sessionId: runtime.sessionId, taskId: runtime.taskId, permissions: runtime.permissions, toolName, arguments: argumentsValue });
  }

  async executePtc(runtime: AgentRuntime, execute: () => Promise<unknown>): Promise<unknown> {
    await this.assertRuntimeAuthority(runtime);
    if (!runtime.definition.toolPolicy.allowPtc || runtime.definition.toolPolicy.executionMode === "native") throw new Error("ptc_not_allowed");
    runtime.budget.consume("ptcExecutions");
    return execute();
  }

  async diagnostics(sessionId?: string): Promise<MultiAgentDiagnostics> {
    const tasks = await this.taskManager.taskStore.list(sessionId === undefined ? {} : { sessionId });
    const taskCounts = { pending: 0, running: 0, waiting: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0 } as Record<AgentTask["status"], number>;
    for (const task of tasks) taskCounts[task.status] += 1;
    let delegationDepth = 0;
    for (const task of tasks) delegationDepth = Math.max(delegationDepth, await this.taskManager.depth(task.id));
    return { registeredAgents: this.registry.list().length, activeAgents: this.activeCount(), taskCounts, delegationDepth, handoffCount: this.messages.length };
  }

  private async executeTask(task: AgentTask, parentSignal: AbortSignal): Promise<void> {
    if (parentSignal.aborted || task.status === "cancelled") return;
    const definition = this.requireDefinition(task.assignedAgentId);
    const parentRuntime = task.parentTaskId === undefined ? undefined : this.runtimes.get(task.parentTaskId);
    const parentPermissions = parentRuntime?.permissions ?? this.hostPermissions;
    const effectivePermissions = intersectPermissions(parentPermissions.length === 0 ? definition.permissions : parentPermissions, definition.permissions);
    const provider = this.providers.get(definition.modelProfile) ?? this.defaultProvider;
    if (provider === undefined) { await this.taskManager.fail(task.id, { reason: "provider_unavailable" }); return; }
    const runtime = new AgentRuntime(definition, task.sessionId, task.id, provider, effectivePermissions, definition.contextPolicy ?? {}, this.childBudgets.get(task.id));
    if (this.events !== undefined) runtime.context.attachEvents(this.events);
    this.runtimes.set(task.id, runtime);
    const controller = new AbortController();
    const abort = () => controller.abort();
    parentSignal.addEventListener("abort", abort, { once: true });
    this.controllers.set(task.id, controller);
    const span = this.tracer?.startSpan("agent.invoke", undefined, { agentId: definition.id, taskId: task.id, sessionId: task.sessionId });
    this.metrics?.increment("agent.invocations", 1, { agent: definition.id, role: definition.role });
    try {
      const started = await this.taskManager.start(task.id);
      runtime.status = "running";
      await this.events?.emit("task.started", { taskId: started.id, agentId: definition.id, sessionId: task.sessionId, attempt: started.attempt });
      await this.events?.emit("agent.started", { agentId: definition.id, instanceId: runtime.instanceId, taskId: task.id, sessionId: task.sessionId });
      runtime.budget.consume("invocations");
      runtime.budget.consume("modelCalls");
      const handoff = this.handoffBuilder.build({ task, senderAgentId: task.createdBy, receiver: definition, summary: typeof task.input.summary === "string" ? task.input.summary : undefined, artifactRefs: task.artifactReferences, memoryRefs: task.memoryReferences, sharedState: (await this.sharedState.get(task.id))?.value });
      const context = runtime.context.buildVisible(task.sessionId, [], definition.instructions);
      const response = await runtime.provider.generate({ sessionId: task.sessionId, input: `${task.objective}\n\nHandoff:\n${JSON.stringify(handoff)}`, context, runtimeInstructions: [`agent-policy/v1 role=${definition.role}`, `permissions=${effectivePermissions.join(",")}`] });
      if (controller.signal.aborted) throw new Error("task_cancelled");
      const output = this.parseOutput(response, definition.structuredOutput);
      if (output.kind === "plan") await this.applyPlan(task, runtime, output);
      else if (output.kind === "delegate") await this.delegate(runtime, output);
      else if (output.kind === "review") await this.applyReview(task, output);
      else await this.taskManager.complete(task.id, { outputReferences: [], memoryReferences: output.memoryRefs, artifactReferences: output.artifactRefs, metadata: { ...task.metadata, output: output.output, summary: output.summary } });
      const afterExecution = await this.requireTask(task.id);
      runtime.status = afterExecution.status === "completed" ? "completed" : "waiting";
      span?.end("ok");
      if (afterExecution.status === "completed") {
        this.metrics?.increment("agent.completed", 1, { agent: definition.id });
        await this.events?.emit("agent.completed", { agentId: definition.id, instanceId: runtime.instanceId, taskId: task.id, sessionId: task.sessionId, status: "completed" });
        await this.events?.emit("task.completed", { taskId: task.id, agentId: definition.id, sessionId: task.sessionId });
      }
    } catch (error) {
      runtime.status = controller.signal.aborted ? "cancelled" : "failed";
      span?.end("error");
      if (controller.signal.aborted) await this.taskManager.cancel(task.id, "cancelled");
      else await this.taskManager.fail(task.id, { reason: error instanceof Error ? error.message : "agent_failed" });
      this.metrics?.increment("agent.failed", 1, { agent: definition.id });
      await this.events?.emit("agent.failed", { agentId: definition.id, instanceId: runtime.instanceId, taskId: task.id, sessionId: task.sessionId, errorCode: controller.signal.aborted ? "cancelled" : "agent_failed" });
      await this.events?.emit("task.failed", { taskId: task.id, agentId: definition.id, sessionId: task.sessionId, errorCode: controller.signal.aborted ? "cancelled" : "agent_failed" });
    } finally {
      parentSignal.removeEventListener("abort", abort);
      this.controllers.delete(task.id);
    }
  }

  private async applyPlan(task: AgentTask, runtime: AgentRuntime, plan: Extract<StructuredAgentOutput, { kind: "plan" }>): Promise<void> {
    if (this.replanCounts.get(task.id) !== undefined && (this.replanCounts.get(task.id)! >= this.maxReplans)) throw new Error("replan_limit_exceeded");
    const existingChildren = await this.taskManager.listChildren(task.id);
    if (existingChildren.length > 0) {
      await this.taskManager.complete(task.id, { metadata: { ...task.metadata, summary: plan.summary, plan } });
      return;
    }
    const childIds: string[] = [];
    for (let index = 0; index < Math.min(plan.tasks.length, this.maxChildTasks); index += 1) {
      const planned = plan.tasks[index]!;
      const dependencies = planned.dependencies.map((dependencyIndex) => childIds[dependencyIndex]).filter((id): id is string => id !== undefined);
      const plannedInput = { ...planned.input };
      if (typeof plannedInput.reviewTargetIndex === "number" && childIds[plannedInput.reviewTargetIndex] !== undefined) plannedInput.reviewTargetTaskId = childIds[plannedInput.reviewTargetIndex];
      const child = await this.delegate(runtime, { agentId: planned.agentId, objective: planned.objective, input: plannedInput, dependencyIds: dependencies, failurePolicy: planned.failurePolicy });
      childIds.push(child.id);
    }
    if (childIds.length === 0) { await this.taskManager.complete(task.id, { metadata: { ...task.metadata, summary: plan.summary, plan } }); return; }
    const current = await this.requireTask(task.id);
    await this.taskManager.taskStore.update(task.id, { status: "waiting", dependencyIds: [...new Set([...current.dependencyIds, ...childIds])], metadata: { ...current.metadata, summary: plan.summary, plan } }, current.revision);
    this.replanCounts.set(task.id, (this.replanCounts.get(task.id) ?? 0) + 1);
  }

  private async applyReview(task: AgentTask, review: Extract<StructuredAgentOutput, { kind: "review" }>): Promise<void> {
    const count = (this.reviewCounts.get(task.id) ?? 0) + 1;
    this.reviewCounts.set(task.id, count);
    if (review.decision === "reject") {
      if (count >= this.maxReviewIterations) throw new Error("review_limit_exceeded");
      const targetId = typeof task.input.reviewTargetTaskId === "string" ? task.input.reviewTargetTaskId : undefined;
      if (targetId === undefined) throw new Error("review_rejected_without_target");
      const target = await this.requireTask(targetId);
      await this.taskManager.taskStore.update(target.id, { status: "pending", metadata: { ...target.metadata, revisionRequested: true, reviewIssues: review.issues } }, target.revision);
      await this.taskManager.taskStore.update(task.id, { status: "waiting", dependencyIds: [target.id], metadata: { ...task.metadata, review } }, task.revision);
      return;
    }
    await this.taskManager.complete(task.id, { artifactReferences: review.artifactRefs, metadata: { ...task.metadata, review } });
  }

  private parseOutput(response: ModelResponse, structured: boolean): StructuredAgentOutput {
    const content = response.kind === "tool-calls" ? JSON.stringify({ kind: "result", summary: "Tool workflow completed.", output: { toolCalls: response.toolCalls } }) : response.content;
    try { return structuredAgentOutputSchema.parse(JSON.parse(content)); } catch (error) { if (structured) throw new Error(`invalid_structured_agent_output:${error instanceof Error ? error.message : "invalid"}`); return structuredAgentOutputSchema.parse({ kind: "result", summary: content.slice(0, 64_000), output: {} }); }
  }

  private dependenciesReady(task: AgentTask, all: readonly AgentTask[]): boolean {
    const byId = new Map(all.map((candidate) => [candidate.id, candidate]));
    return task.dependencyIds.every((dependencyId) => byId.get(dependencyId)?.status === "completed" || (byId.get(dependencyId)?.status === "failed" && task.failurePolicy === "continue-with-partial"));
  }

  private activeCount(): number { return [...this.runtimes.values()].filter((runtime) => runtime.status === "running").length; }
  private requireDefinition(id: string | undefined): AgentDefinition { if (id === undefined) throw new Error("task_agent_unassigned"); const definition = this.registry.get(id); if (definition === undefined) throw new Error(`unknown_or_disabled_agent:${id}`); return definition; }
  private async requireTask(id: string): Promise<AgentTask> { const task = await this.taskManager.taskStore.get(id); if (task === undefined) throw new Error(`Unknown task: ${id}`); return task; }

  private async assertRuntimeAuthority(runtime: AgentRuntime): Promise<void> {
    const task = await this.requireTask(runtime.taskId);
    const definition = this.requireDefinition(task.assignedAgentId);
    if (runtime.sessionId !== task.sessionId || runtime.definition.id !== definition.id) throw new Error("agent_identity_mismatch");
    const recordedPermissions = Array.isArray(task.metadata.effectivePermissions) ? task.metadata.effectivePermissions.filter((value): value is string => typeof value === "string") : undefined;
    const parentPermissions = recordedPermissions ?? (this.hostPermissions.length === 0 ? definition.permissions : this.hostPermissions);
    const expectedPermissions = intersectPermissions(parentPermissions, definition.permissions);
    if (runtime.permissions.some((permission) => !expectedPermissions.includes(permission))) throw new Error("permission_inheritance_violation");
    const expectedBudget = task.parentTaskId === undefined ? definition.budget : this.childBudgets.get(task.id);
    if (expectedBudget !== undefined && !budgetWithin(runtime.budget.allocation, expectedBudget)) throw new Error("budget_inheritance_violation");
  }
}

function positive(value: number, name: string): number { if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be positive`); return value; }
function positiveOrZero(value: number, name: string): number { if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be non-negative`); return value; }
function truncateUtf8(value: string, maximumBytes: number): string { let result = ""; let used = 0; for (const character of value) { const bytes = Buffer.byteLength(character); if (used + bytes > maximumBytes) break; result += character; used += bytes; } return result; }

function budgetWithin(actual: AgentBudget, expected: AgentBudget): boolean {
  const bounded = ["maxModelCalls", "maxToolCalls", "maxPtcExecutions", "maxChildTasks", "maxTokens", "costBudget", "maxInvocations"] as const;
  return bounded.every((key) => expected[key] === 0 || actual[key] <= expected[key]);
}
