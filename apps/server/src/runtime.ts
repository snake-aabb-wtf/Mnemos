import { randomUUID } from "node:crypto";
import { EventBus, RuntimeHealthService, type HarnessEventMap } from "@mnemos/core";
import {
  chatActivitySchema, chatGenerationDtoSchema, chatMessageDtoSchema, chatMessagesDtoSchema, chatStreamEventDtoSchema,
  metaDtoSchema, runtimeSummaryDtoSchema, sessionDetailDtoSchema, sessionPageDtoSchema, sessionSummaryDtoSchema,
  type ChatActivity, type ChatGenerationDto, type ChatMessageDto, type ChatMessagesDto, type ChatStreamEventDto,
  type CreateSessionInput, type MetaDto, type RuntimeSummaryDto, type SessionDetailDto, type SessionPageDto, type SessionSummaryDto,
  contextInspectorDtoSchema, memoryDetailDtoSchema, memoryInspectorQuerySchema, memoryPageDtoSchema, memorySourceDtoSchema,
  historyMessageDtoSchema, retrievalInspectorDtoSchema, type ContextInspectorDto, type MemoryDetailDto, type MemoryInspectorQuery,
  type MemoryPageDto, type MemorySourceDto, type HistoryMessageDto, type RetrievalInspectorDto, type MemorySummaryDto,
  artifactPageDtoSchema, artifactDetailDtoSchema, artifactInspectorQuerySchema, type ArtifactPageDto, type ArtifactDetailDto, type ArtifactInspectorQuery, type ArtifactSummaryDto,
  toolPageDtoSchema, toolInspectorQuerySchema, type ToolPageDto, type ToolInspectorQuery, type ToolSummaryDto,
  ptcPageDtoSchema, ptcExecutionDetailDtoSchema, type PtcPageDto, type PtcExecutionDetailDto, type PtcExecutionSummaryDto,
  agentPageDtoSchema, agentDetailDtoSchema, type AgentPageDto, type AgentDetailDto, type AgentSummaryDto,
  taskPageDtoSchema, taskDetailDtoSchema, taskGraphDtoSchema, type TaskPageDto, type TaskDetailDto, type TaskGraphDto, type TaskSummaryDto,
  runtimeMetricsDtoSchema, operationsDtoSchema, type RuntimeMetricsDto, type OperationsDto, type WorkerSummaryDto, type JobSummaryDto,
} from "@mnemos/contracts";

export interface SessionQuery { limit: number; cursor?: string; }
export interface ConsoleRuntimeService {
  readonly health: RuntimeHealthService;
  readonly events: EventBus<HarnessEventMap>;
  meta(): Promise<MetaDto>;
  summary(): Promise<RuntimeSummaryDto>;
  listSessions(query: SessionQuery): Promise<SessionPageDto>;
  getSession(sessionId: string): Promise<SessionDetailDto | undefined>;
  createDemoSession?(): Promise<SessionSummaryDto>;
}

/** Runtime-owned chat boundary. Fastify only validates/streams this contract;
 * a production composition root can inject a Harness-backed implementation. */
export interface ChatRuntimeService extends ConsoleRuntimeService {
  createSession(input?: CreateSessionInput): Promise<SessionSummaryDto>;
  listMessages(sessionId: string, query?: SessionQuery): Promise<ChatMessagesDto | undefined>;
  startGeneration(sessionId: string, content: string, retryOfMessageId?: string): Promise<ChatGenerationDto>;
  subscribeGeneration(sessionId: string, generationId: string, listener: (event: ChatStreamEventDto) => void): () => void;
  cancelGeneration(sessionId: string, generationId: string): Promise<boolean>;
}

/** Read-only observability boundary for F3. Implementations map their real
 * ContextManager/MemoryRetriever/History stores into bounded public DTOs. */
export interface InspectorRuntimeService extends ChatRuntimeService {
  contextInspector(sessionId: string): Promise<ContextInspectorDto | undefined>;
  searchMemory(query: MemoryInspectorQuery): Promise<MemoryPageDto>;
  getMemory(memoryId: string): Promise<MemoryDetailDto | undefined>;
  memorySources(memoryId: string): Promise<MemorySourceDto[] | undefined>;
  getHistoryMessage(sessionId: string, messageId: string): Promise<HistoryMessageDto | undefined>;
  retrievalInspector(sessionId: string, messageId: string): Promise<RetrievalInspectorDto | undefined>;
}

export interface AdvancedInspectorRuntimeService extends InspectorRuntimeService {
  searchArtifacts(query: ArtifactInspectorQuery): Promise<ArtifactPageDto>;
  getArtifact(id: string, options?: { offset?: number; length?: number; query?: string }): Promise<ArtifactDetailDto | undefined>;
  listTools(query: ToolInspectorQuery): Promise<ToolPageDto>;
  listPtcExecutions(query?: SessionQuery): Promise<PtcPageDto>;
  getPtcExecution(id: string): Promise<PtcExecutionDetailDto | undefined>;
  listAgents(query?: SessionQuery): Promise<AgentPageDto>;
  getAgent(id: string): Promise<AgentDetailDto | undefined>;
  listTasks(query?: SessionQuery): Promise<TaskPageDto>;
  getTask(id: string): Promise<TaskDetailDto | undefined>;
  taskGraph(rootTaskId?: string): Promise<TaskGraphDto>;
  metrics(): Promise<RuntimeMetricsDto>;
  operations(): Promise<OperationsDto>;
}

interface DemoSession { summary: SessionSummaryDto; messages: ChatMessageDto[]; }
interface Generation {
  sessionId: string; id: string; assistantMessageId: string; controller: AbortController;
  events: ChatStreamEventDto[]; listeners: Set<(event: ChatStreamEventDto) => void>; nextSequence: number; done: boolean;
}

/** Deterministic offline runtime used by the Console demo and E2E suite. It
 * lives behind the same boundary as a real Harness adapter, so HTTP never
 * owns the agent loop or canonical message state. */
export class DemoConsoleRuntimeService implements AdvancedInspectorRuntimeService {
  readonly events = new EventBus<HarnessEventMap>();
  readonly health: RuntimeHealthService;
  private readonly startedAt = Date.now();
  private readonly sessions = new Map<string, DemoSession>();
  private readonly generations = new Map<string, Generation>();
  private readonly contexts = new Map<string, ContextInspectorDto>();
  private readonly memories = new Map<string, MemorySummaryDto>();
  private readonly memorySourcesById = new Map<string, MemorySourceDto[]>();
  private readonly retrievalByMessage = new Map<string, RetrievalInspectorDto>();
  private readonly artifacts = new Map<string, ArtifactSummaryDto>();
  private readonly tools = new Map<string, ToolSummaryDto>();
  private readonly ptcExecutions = new Map<string, PtcExecutionDetailDto>();
  private readonly agents = new Map<string, AgentDetailDto>();
  private readonly tasks = new Map<string, TaskDetailDto>();
  private requestCount = 0;
  private toolCallCount = 0;
  private ptcCount = 0;
  private readonly metricSeries = { requests: [] as { at: string; value: number }[], pressure: [] as { at: string; value: number }[], queue: [] as { at: string; value: number }[] };

  constructor(private readonly profile: "development" | "test" = "test") {
    this.health = new RuntimeHealthService([
      { name: "database", check: async () => ({ ok: true, detail: "demo in-memory store" }) },
      { name: "migrations", check: async () => ({ ok: true, detail: "demo schema ready" }) },
      { name: "artifact-store", check: async () => ({ ok: true, detail: "demo artifact adapter" }) },
      { name: "workers", check: async () => ({ ok: true, detail: "demo worker boundary" }) },
      { name: "sandbox", check: async () => ({ ok: true, detail: "demo sandbox adapter" }) },
    ], "0.1.0");
    this.seed("demo-session-01", "Console smoke session");
    this.seedInspectorFixtures("demo-session-01");
    this.seedAdvancedFixtures("demo-session-01");
  }

  async meta(): Promise<MetaDto> { return metaDtoSchema.parse({ version: "0.1.0", apiVersion: "v1", schemaVersion: 1, serverTime: new Date().toISOString() }); }
  async summary(): Promise<RuntimeSummaryDto> {
    const activeSessions = [...this.sessions.values()].filter((session) => session.summary.status === "active").length;
    return runtimeSummaryDtoSchema.parse({ status: "ready", version: "0.1.0", uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000), sessionsCount: this.sessions.size, activeSessions, registeredAgents: this.agents.size, activeAgents: [...this.agents.values()].filter((agent) => agent.status === "running").length, queuedJobs: [...this.tasks.values()].filter((task) => task.status === "pending").length, runningPtcExecutions: [...this.ptcExecutions.values()].filter((execution) => execution.status === "running").length, memoryCount: this.memories.size, artifactCount: this.artifacts.size, contextLimitTokens: 131_072, sandboxBackend: "demo", sandboxStatus: "available", profile: this.profile });
  }
  async listSessions(query: SessionQuery): Promise<SessionPageDto> {
    const sessions = [...this.sessions.values()].map((entry) => entry.summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const offset = decodeCursor(query.cursor); const items = sessions.slice(offset, offset + query.limit); const nextOffset = offset + items.length;
    return sessionPageDtoSchema.parse({ items, ...(nextOffset < sessions.length ? { nextCursor: encodeCursor(nextOffset) } : {}) });
  }
  async getSession(sessionId: string): Promise<SessionDetailDto | undefined> {
    const session = this.sessions.get(sessionId); if (!session) return undefined;
    const recentMessages = session.messages.slice(-20).map((message) => ({ id: message.id, role: message.role, preview: message.content.slice(0, 512), createdAt: message.createdAt }));
    return sessionDetailDtoSchema.parse({ ...session.summary, recentMessages, activeAgentIds: ["visible.general"], taskSummary: { pending: 0, running: 0, completed: 0, failed: 0 } });
  }
  async createSession(input: CreateSessionInput = {}): Promise<SessionSummaryDto> { return this.seed(`session-${randomUUID().slice(0, 12)}`, input.displayName ?? "New conversation", true); }
  async createDemoSession(): Promise<SessionSummaryDto> { const session = await this.createSession({ displayName: "New demo session" }); await this.emitDemoEvent(); return session; }
  async listMessages(sessionId: string, query: SessionQuery = { limit: 100 }): Promise<ChatMessagesDto | undefined> {
    const session = this.sessions.get(sessionId); if (!session) return undefined;
    const offset = decodeCursor(query.cursor); const items = session.messages.slice(offset, offset + Math.min(query.limit, 1_000)); const nextOffset = offset + items.length;
    return chatMessagesDtoSchema.parse({ sessionId, items, ...(nextOffset < session.messages.length ? { nextCursor: encodeCursor(nextOffset) } : {}) });
  }

  async contextInspector(sessionId: string): Promise<ContextInspectorDto | undefined> {
    const session = this.sessions.get(sessionId); if (!session) return undefined;
    this.syncContext(sessionId);
    return structuredClone(this.contexts.get(sessionId));
  }

  async searchMemory(input: MemoryInspectorQuery): Promise<MemoryPageDto> {
    const query = memoryInspectorQuerySchema.parse(input);
    const needle = query.query.toLocaleLowerCase();
    const records = [...this.memories.values()].filter((memory) => {
      if (needle && !`${memory.content} ${memory.entities.join(" ")} ${memory.tags.join(" ")}`.toLocaleLowerCase().includes(needle)) return false;
      if (query.type && memory.type !== query.type) return false;
      if (query.status && memory.status !== query.status) return false;
      if (query.sourceType && memory.sourceType !== query.sourceType) return false;
      if (query.scopeKind && memory.scope.kind !== query.scopeKind) return false;
      if (query.scopeId && memory.scope.id !== query.scopeId) return false;
      if (query.sessionId && !memory.sourceReferences.some((source) => source.sessionId === query.sessionId)) return false;
      return true;
    }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const offset = decodeCursor(query.cursor); const items = records.slice(offset, offset + query.limit); const nextOffset = offset + items.length;
    return memoryPageDtoSchema.parse({ items, total: records.length, ...(nextOffset < records.length ? { nextCursor: encodeCursor(nextOffset) } : {}) });
  }

  async getMemory(memoryId: string): Promise<MemoryDetailDto | undefined> {
    const memory = this.memories.get(memoryId); if (!memory) return undefined;
    const related = [...this.memories.values()].filter((candidate) => candidate.id !== memory.id && (candidate.entities.some((entity) => memory.entities.includes(entity)) || candidate.scope.id === memory.scope.id));
    const timeline = [...this.memories.values()].filter((candidate) => candidate.entities.some((entity) => memory.entities.includes(entity))).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return memoryDetailDtoSchema.parse({ ...memory, timeline: timeline.slice(0, 100), relatedMemoryIds: related.slice(0, 100).map((candidate) => candidate.id) });
  }

  async memorySources(memoryId: string): Promise<MemorySourceDto[] | undefined> {
    if (!this.memories.has(memoryId)) return undefined;
    return structuredClone(this.memorySourcesById.get(memoryId) ?? []);
  }

  async getHistoryMessage(sessionId: string, messageId: string): Promise<HistoryMessageDto | undefined> {
    const session = this.sessions.get(sessionId); if (!session) return undefined;
    const index = session.messages.findIndex((message) => message.id === messageId); const message = session.messages[index]; if (!message) return undefined;
    return historyMessageDtoSchema.parse({ id: message.id, sessionId, role: message.role, content: boundedText(message.content, 20_000), createdAt: message.createdAt, ...(session.messages[index - 1] ? { beforeId: session.messages[index - 1].id } : {}), ...(session.messages[index + 1] ? { afterId: session.messages[index + 1].id } : {}) });
  }

  async retrievalInspector(sessionId: string, messageId: string): Promise<RetrievalInspectorDto | undefined> {
    const session = this.sessions.get(sessionId); if (!session || !session.messages.some((message) => message.id === messageId)) return undefined;
    return structuredClone(this.retrievalByMessage.get(`${sessionId}:${messageId}`) ?? { sessionId, messageId, query: "", results: [], total: 0 });
  }

  async searchArtifacts(input: ArtifactInspectorQuery): Promise<ArtifactPageDto> {
    const query = artifactInspectorQuerySchema.parse(input); const needle = query.query.toLowerCase();
    const rows = [...this.artifacts.values()].filter((artifact) => (!needle || `${artifact.id} ${artifact.type} ${artifact.summary ?? ""}`.toLowerCase().includes(needle)) && (!query.mimeType || artifact.mimeType === query.mimeType) && (!query.sessionId || artifact.sessionId === query.sessionId) && (!query.taskId || artifact.taskId === query.taskId) && (!query.agentId || artifact.agentId === query.agentId));
    const offset = decodeCursor(query.cursor); const items = rows.slice(offset, offset + query.limit); const next = offset + items.length;
    return artifactPageDtoSchema.parse({ items, total: rows.length, ...(next < rows.length ? { nextCursor: encodeCursor(next) } : {}) });
  }

  async getArtifact(id: string, options: { offset?: number; length?: number; query?: string } = {}): Promise<ArtifactDetailDto | undefined> {
    const artifact = this.artifacts.get(id); if (!artifact) return undefined;
    const content = id.endsWith("json") ? JSON.stringify({ artifact: id, rows: ["bounded", "preview", "only"] }, null, 2) : "Mnemos artifact preview. This body is intentionally bounded by the inspector contract.\nline: runtime metadata\nline: source references remain in the canonical store.";
    const offset = Math.max(0, options.offset ?? 0); const length = Math.min(16_384, Math.max(0, options.length ?? 4_096)); const raw = content.slice(offset, offset + length);
    const matches = options.query ? content.split("\n").map((line, index) => line.toLowerCase().includes(options.query!.toLowerCase()) ? { artifactId: id, byteOffset: content.indexOf(line), lineNumber: index + 1, preview: boundedText(line, 2_000) } : undefined).filter((value): value is { artifactId: string; byteOffset: number; lineNumber: number; preview: string } => value !== undefined).slice(0, 50) : undefined;
    return artifactDetailDtoSchema.parse({ ...artifact, preview: { encoding: artifact.mimeType === "application/json" ? "json" : "utf8", content: boundedText(content, 16_384), truncated: content.length > 16_384 }, range: { offset, length: raw.length, content: raw, truncated: offset + raw.length < content.length }, ...(matches ? { queryMatches: matches } : {}) });
  }

  async listTools(input: ToolInspectorQuery): Promise<ToolPageDto> {
    const query = toolInspectorQuerySchema.parse(input); const needle = query.query.toLowerCase();
    const rows = [...this.tools.values()].filter((tool) => (!needle || `${tool.name} ${tool.description} ${tool.namespace}`.toLowerCase().includes(needle)) && (!query.namespace || tool.namespace === query.namespace) && (query.loaded === undefined || tool.loaded === query.loaded));
    const offset = decodeCursor(query.cursor); const items = rows.slice(offset, offset + query.limit); const next = offset + items.length;
    return toolPageDtoSchema.parse({ items, total: rows.length, loadedCount: rows.filter((tool) => tool.loaded).length, ...(next < rows.length ? { nextCursor: encodeCursor(next) } : {}) });
  }
  async listPtcExecutions(query: SessionQuery = { limit: 25 }): Promise<PtcPageDto> { const rows = [...this.ptcExecutions.values()].map(({ timeline: _timeline, codePreview: _codePreview, resultPreview: _resultPreview, artifactIds: _artifactIds, permissions: _permissions, ...summary }) => summary); const offset = decodeCursor(query.cursor); const items = rows.slice(offset, offset + query.limit); const next = offset + items.length; return ptcPageDtoSchema.parse({ items, total: rows.length, ...(next < rows.length ? { nextCursor: encodeCursor(next) } : {}) }); }
  async getPtcExecution(id: string): Promise<PtcExecutionDetailDto | undefined> { const value = this.ptcExecutions.get(id); return value ? structuredClone(value) : undefined; }
  async listAgents(query: SessionQuery = { limit: 50 }): Promise<AgentPageDto> { const rows = [...this.agents.values()].map(({ instructionsPreview: _instructions, objective: _objective, loadedToolNames: _loaded, artifactIds: _artifacts, memoryRefs: _memory, localStateKeys: _state, ...summary }) => summary); const offset = decodeCursor(query.cursor); const items = rows.slice(offset, offset + query.limit); const next = offset + items.length; return agentPageDtoSchema.parse({ items, total: rows.length, ...(next < rows.length ? { nextCursor: encodeCursor(next) } : {}) }); }
  async getAgent(id: string): Promise<AgentDetailDto | undefined> { const value = this.agents.get(id); return value ? structuredClone(value) : undefined; }
  async listTasks(query: SessionQuery = { limit: 100 }): Promise<TaskPageDto> { const rows = [...this.tasks.values()].map(({ inputPreview: _input, outputPreview: _output, sharedState: _state, localSummary: _summary, handoffs: _handoffs, failure: _failure, ...summary }) => summary); const offset = decodeCursor(query.cursor); const items = rows.slice(offset, offset + query.limit); const next = offset + items.length; return taskPageDtoSchema.parse({ items, total: rows.length, ...(next < rows.length ? { nextCursor: encodeCursor(next) } : {}) }); }
  async getTask(id: string): Promise<TaskDetailDto | undefined> { const value = this.tasks.get(id); return value ? structuredClone(value) : undefined; }
  async taskGraph(rootTaskId = "task-demo-root"): Promise<TaskGraphDto> {
    const tasks = [...this.tasks.values()];
    const nodes = tasks.map((task, index) => ({
      id: task.id,
      type: "task" as const,
      label: task.objective,
      status: task.status,
      role: this.agents.get(task.assignedAgentId ?? "")?.role,
      agentId: task.assignedAgentId,
      taskId: task.id,
      position: { x: (index % 3) * 280, y: Math.floor(index / 3) * 150 },
    }));
    const dependencyEdges = tasks.flatMap((task) =>
      task.dependencyIds.map((dependencyId) => ({
        id: `edge-${dependencyId}-${task.id}`,
        source: dependencyId,
        target: task.id,
        kind: "dependency" as const,
      })),
    );
    const workflowEdges = [
      { id: "edge-root-research-a", source: "task-demo-root", target: "task-demo-research-a", kind: "delegation" as const },
      { id: "edge-root-research-b", source: "task-demo-root", target: "task-demo-research-b", kind: "delegation" as const },
      { id: "edge-coder-review", source: "task-demo-coder", target: "task-demo-review", kind: "review" as const },
      { id: "edge-review-final", source: "task-demo-review", target: "task-demo-final", kind: "handoff" as const },
    ];
    return taskGraphDtoSchema.parse({ rootTaskId, nodes, edges: [...dependencyEdges, ...workflowEdges], generatedAt: new Date().toISOString() });
  }
  async metrics(): Promise<RuntimeMetricsDto> {
    const now = new Date().toISOString(); const pressure = [...this.contexts.values()][0]?.stats.pressure ?? 0; const queueDepth = [...this.tasks.values()].filter((task) => task.status === "pending").length; this.metricSeries.requests.push({ at: now, value: this.requestCount }); this.metricSeries.pressure.push({ at: now, value: pressure }); this.metricSeries.queue.push({ at: now, value: queueDepth });
    return runtimeMetricsDtoSchema.parse({ generatedAt: now, requestsTotal: this.requestCount, modelCalls: this.requestCount, providerFailures: 0, contextPressure: pressure, compactions: [...this.contexts.values()].reduce((count, context) => count + context.compactions.length, 0), memoryConsolidations: this.memories.size, retrievalLatencyMs: 4.2, toolCalls: this.toolCallCount, ptcExecutions: this.ptcCount, artifactSpills: [...this.artifacts.values()].filter((artifact) => artifact.sizeBytes > 64_000).length, queueDepth, activeWorkers: 1, sessions: this.sessions.size, activeAgents: [...this.agents.values()].filter((agent) => agent.status === "running").length, activeTasks: [...this.tasks.values()].filter((task) => task.status === "running").length, series: { requests: this.metricSeries.requests.slice(-60), pressure: this.metricSeries.pressure.slice(-60), queue: this.metricSeries.queue.slice(-60) } });
  }
  async operations(): Promise<OperationsDto> { const now = new Date().toISOString(); const health = this.health.liveness(); const readiness = await this.health.readiness(); const workers: WorkerSummaryDto[] = [{ id: "worker-demo-01", status: "idle", completedJobs: 14, failedJobs: 1, heartbeatAt: now }]; const jobs: JobSummaryDto[] = [{ id: "job-demo-consolidation", type: "consolidation", status: "completed", attempts: 1, availableAt: now, workerId: workers[0].id, createdAt: now }]; return operationsDtoSchema.parse({ generatedAt: now, health, readiness, workers, jobs, storage: { memoryCount: this.memories.size, artifactCount: this.artifacts.size }, migrations: { schemaVersion: 1, pending: 0 }, sandbox: { backend: "demo-subprocess", status: "available", capabilities: ["rpc-only", "wall-clock-timeout", "bounded-output"] }, provider: { status: "available", names: ["deterministic-demo"] }, audit: { rows: this.toolCallCount + this.ptcCount, retention: "in-memory demo" } }); }

  async startGeneration(sessionId: string, content: string, retryOfMessageId?: string): Promise<ChatGenerationDto> {
    this.requestCount += 1;
    const session = this.sessions.get(sessionId); if (!session) throw notFound("Session not found.");
    const generationId = `gen-${randomUUID().slice(0, 12)}`; const now = new Date().toISOString(); let attempt = 1; let userMessageId: string | undefined;
    if (retryOfMessageId) {
      const original = session.messages.find((message) => message.id === retryOfMessageId);
      if (!original || original.role !== "assistant") throw badRequest("retry_of_message_not_found", "Only an assistant message can be regenerated.");
      attempt = (original.attempt ?? 1) + 1;
      userMessageId = session.messages.slice(0, session.messages.indexOf(original)).reverse().find((message) => message.role === "user")?.id;
    } else {
      session.messages.push(chatMessageDtoSchema.parse({ id: `msg-${randomUUID().slice(0, 12)}`, sessionId, role: "user", content, status: "completed", createdAt: now, updatedAt: now }));
      userMessageId = session.messages[session.messages.length - 1]?.id;
    }
    const assistant = chatMessageDtoSchema.parse({ id: `msg-${randomUUID().slice(0, 12)}`, sessionId, role: "assistant", content: "", status: "streaming", createdAt: now, updatedAt: now, generationId, attempt, ...(retryOfMessageId ? { retryOfMessageId } : {}) });
    session.messages.push(assistant); this.touch(session);
    const generation: Generation = { sessionId, id: generationId, assistantMessageId: assistant.id, controller: new AbortController(), events: [], listeners: new Set(), nextSequence: 0, done: false };
    this.generations.set(generationId, generation); this.emitChat(generation, { type: "started", messageId: assistant.id });
    void this.runGeneration(generation, session, content || this.retrySource(session, retryOfMessageId));
    return chatGenerationDtoSchema.parse({ sessionId, generationId, userMessageId: userMessageId ?? assistant.id, assistantMessageId: assistant.id, status: "started" });
  }
  subscribeGeneration(sessionId: string, generationId: string, listener: (event: ChatStreamEventDto) => void): () => void {
    const generation = this.generations.get(generationId); if (!generation || generation.sessionId !== sessionId) return () => undefined;
    for (const event of generation.events) listener(event); if (generation.done) return () => undefined; generation.listeners.add(listener); return () => generation.listeners.delete(listener);
  }
  async cancelGeneration(sessionId: string, generationId: string): Promise<boolean> { const generation = this.generations.get(generationId); if (!generation || generation.sessionId !== sessionId || generation.done) return false; generation.controller.abort(); return true; }
  async emitDemoEvent(): Promise<void> { await this.events.emit("runtime.ready", { runtimeVersion: "0.1.0", schemaVersion: 1 }); }

  private async runGeneration(generation: Generation, session: DemoSession, prompt: string): Promise<void> {
    const mode = prompt.toLowerCase();
    const activities: ChatActivity[] = [{ kind: "memory", label: "Searching memory…" }];
    if (mode.includes("[ptc]")) activities.push({ kind: "ptc", label: "Running PTC…" });
    else if (mode.includes("[tool]")) activities.push({ kind: "tool", label: "Calling memory.search…" });
    if (mode.includes("[compact]")) activities.push({ kind: "context", label: "Checking context pressure…" });
    try {
      for (const activity of activities) { await delay(22); if (generation.controller.signal.aborted) return this.finishCancelled(generation, session); this.emitChat(generation, { type: "activity", activity: chatActivitySchema.parse(activity) }); }
      if (mode.includes("[fail]")) { await delay(20); this.finishFailed(generation, session, "generation_failed"); return; }
      const response = mode.includes("[long]") ? `I can help with “${prompt.replace(/\[long\]/gi, "").trim()}”. This demo response is intentionally streamed in many small deltas so cancellation and recovery remain observable. The runtime keeps the canonical message and marks the attempt when it stops.` : `I can help with “${prompt}”. The demo runtime streamed this response through the same chat contract used by a Harness-backed server.`;
      for (const chunk of chunkText(response, 24)) { await delay(18); if (generation.controller.signal.aborted) return this.finishCancelled(generation, session); const message = this.assistant(generation, session); if (!message) return; message.content += chunk; message.updatedAt = new Date().toISOString(); this.emitChat(generation, { type: "text_delta", messageId: message.id, delta: chunk }); }
      this.finishCompleted(generation, session);
    } catch { this.finishFailed(generation, session, "generation_failed"); }
  }
  private finishCompleted(generation: Generation, session: DemoSession): void { const message = this.assistant(generation, session); if (!message) return; message.status = "completed"; message.updatedAt = new Date().toISOString(); this.recordRetrieval(session.summary.id, message.id, session.messages.slice(0, -1).findLast((candidate) => candidate.role === "user")?.content ?? ""); this.touch(session); this.syncContext(session.summary.id); this.emitChat(generation, { type: "completed", messageId: message.id, message }); }
  private finishCancelled(generation: Generation, session: DemoSession): void { const message = this.assistant(generation, session); if (!message) return; message.status = "cancelled"; message.updatedAt = new Date().toISOString(); this.touch(session); this.syncContext(session.summary.id); this.emitChat(generation, { type: "cancelled", messageId: message.id, message }); }
  private finishFailed(generation: Generation, session: DemoSession, errorCode: string): void { const message = this.assistant(generation, session); if (!message) return; message.status = "failed"; message.updatedAt = new Date().toISOString(); this.touch(session); this.syncContext(session.summary.id); this.emitChat(generation, { type: "failed", messageId: message.id, message, errorCode }); }
  private assistant(generation: Generation, session: DemoSession): ChatMessageDto | undefined { return session.messages.find((item) => item.id === generation.assistantMessageId); }
  private retrySource(session: DemoSession, id: string | undefined): string { if (!id) return "Continue the previous request."; const index = session.messages.findIndex((item) => item.id === id); return session.messages.slice(0, index).reverse().find((item) => item.role === "user")?.content ?? "Continue the previous request."; }
  private emitChat(generation: Generation, partial: Omit<ChatStreamEventDto, "id" | "sessionId" | "generationId" | "sequence" | "timestamp">): void {
    if (generation.done && !["completed", "cancelled", "failed"].includes(partial.type)) return;
    const event = chatStreamEventDtoSchema.parse({ id: randomUUID(), sessionId: generation.sessionId, generationId: generation.id, sequence: generation.nextSequence++, timestamp: new Date().toISOString(), ...partial });
    generation.events.push(event); for (const listener of generation.listeners) { try { listener(event); } catch { /* observers cannot break runtime */ } }
    if (["completed", "cancelled", "failed"].includes(event.type)) { generation.done = true; generation.listeners.clear(); }
  }
  private seedInspectorFixtures(sessionId: string): void {
    const session = this.sessions.get(sessionId); if (!session) return;
    const createdAt = session.summary.createdAt;
    const firstId = session.messages[0]?.id ?? `${sessionId}-m1`;
    const lastId = session.messages.at(-1)?.id ?? firstId;
    const range = { firstMessageId: firstId, lastMessageId: lastId, messageCount: Math.max(1, session.messages.length) };
    const autoPin = { id: "automatic-compaction", source: "automatic" as const, priority: "normal" as const, tokenEstimate: 980, contentPreview: "Canonical source: early runtime decisions remain available through History.", createdAt, sessionId, sourceRange: range };
    const pins = [
      { id: "system-runtime", source: "system" as const, priority: "critical" as const, tokenEstimate: 2_180, contentPreview: "History is canonical; Context is a bounded working set.", createdAt },
      ...(session.messages.length ? [autoPin] : []),
      { id: "agent-current-goal", source: "visible-agent" as const, priority: "normal" as const, tokenEstimate: 210, contentPreview: "Keep the Console read-only and preserve source provenance.", createdAt, sessionId, expiresAtTurn: 20 },
    ];
    const compactions = session.messages.length ? [{ id: "compact-demo-01", sessionId, createdAt, kind: "turn" as const, sourceRange: range, cutoffAfterMessageId: firstId, cutoffBeforeMessageId: lastId, evictedMessageCount: 1, evictedTokens: 7_240, retainedTokens: 1_220, beforeTokens: 8_460, afterTokens: 4_140, automaticPinId: autoPin.id, automaticPinPreview: autoPin.contentPreview }] : [];
    this.contexts.set(sessionId, contextInspectorDtoSchema.parse({ sessionId, currentTurn: Math.max(1, session.messages.length), historyMessageCount: session.messages.length, stats: { usedTokens: 17_640, contextLimit: 131_072, availableTokens: 113_432, safeHeadroomTokens: 93_432, systemTokens: 3_100, pinnedTokens: 3_370, recentRawTokens: 1_220, artifactHandleTokens: 0, toolSchemaTokens: 3_450, retrievedMemoryTokens: 1_200, toolResultTokens: 300, reservedTokens: 20_000, generationReserveTokens: 20_000, pressure: 0.287, pressureLevel: "NORMAL", recentRawTargetTokens: 48_000 }, policy: { level: "NORMAL", recommendations: ["continue_normal"], enforced: false, effectiveRecentRawTarget: 48_000, effectiveRetrievalTokenBudget: 8_000, effectiveToolSchemaBudget: 8_000, effectiveToolResultBudget: 16_000, generationReserveTokens: 20_000 }, pins, compactions, retrievedMemoryCount: 1, loadedToolCount: 8 }));
    if (!this.memories.size) {
      const ts = createdAt;
      const make = (record: MemorySummaryDto): void => { this.memories.set(record.id, record); this.memorySourcesById.set(record.id, record.sourceReferences.map((source, ordinal) => { const message = this.sessions.get(source.sessionId)?.messages.find((candidate) => candidate.id === source.messageId); return { memoryId: record.id, sessionId: source.sessionId, messageId: source.messageId, role: message?.role ?? (ordinal === 0 ? "user" : "assistant"), content: boundedText(message?.content ?? (ordinal === 0 ? "Inspect the runtime foundation." : "The runtime is ready for observation."), 20_000), createdAt: message?.createdAt ?? ts, ordinal }; })); };
      make({ id: "memory-typescript", type: "semantic", content: "Mnemos uses TypeScript for the runtime.", sourceIds: [firstId, lastId], sourceReferences: [{ sessionId, messageId: firstId }, { sessionId, messageId: lastId }], createdAt: ts, updatedAt: ts, lastConfirmedAt: ts, importance: 0.86, confidence: 0.94, sourceType: "explicit_user_statement", status: "active", derivedFromMemoryIds: [], confirmationCount: 3, reinforcementScore: 0.8, stale: false, durability: "durable", scope: { kind: "project", id: "mnemos" }, entities: ["Mnemos", "TypeScript"], tags: ["architecture", "language"] });
      make({ id: "memory-postgres", type: "decision", content: "The project uses PostgreSQL as its primary database.", sourceIds: [lastId], sourceReferences: [{ sessionId, messageId: lastId }], createdAt: ts, updatedAt: ts, lastConfirmedAt: ts, importance: 0.9, confidence: 0.91, sourceType: "explicit_user_statement", status: "active", derivedFromMemoryIds: [], confirmationCount: 2, reinforcementScore: 0.55, stale: false, durability: "durable", scope: { kind: "project", id: "mnemos" }, entities: ["Mnemos", "PostgreSQL"], tags: ["decision", "database"] });
      make({ id: "memory-sqlite", type: "decision", content: "The early prototype used SQLite during local development.", sourceIds: [firstId], sourceReferences: [{ sessionId, messageId: firstId }], createdAt: ts, updatedAt: ts, importance: 0.45, confidence: 0.76, sourceType: "tool_observation", status: "superseded", supersededBy: "memory-postgres", derivedFromMemoryIds: [], confirmationCount: 1, reinforcementScore: 0.1, stale: false, durability: "normal", scope: { kind: "project", id: "mnemos" }, entities: ["Mnemos", "SQLite"], tags: ["history", "database"] });
      make({ id: "memory-compaction", type: "episodic", content: "Context compaction preserves canonical History and updates an automatic pin.", sourceIds: [firstId, lastId], sourceReferences: [{ sessionId, messageId: firstId }, { sessionId, messageId: lastId }], createdAt: ts, updatedAt: ts, importance: 0.63, confidence: 0.88, sourceType: "derived_summary", status: "active", derivedFromMemoryIds: ["memory-typescript"], confirmationCount: 2, reinforcementScore: 0.4, stale: false, durability: "normal", scope: { kind: "session", id: sessionId }, entities: ["Context", "History"], tags: ["compaction", "runtime"] });
    }
  }

  private seedAdvancedFixtures(sessionId: string): void {
    const now = new Date().toISOString();
    const artifact = (id: string, type: string, mimeType: string, sizeBytes: number, summary: string, taskId?: string, agentId?: string): void => { this.artifacts.set(id, { id, type, mimeType, sizeBytes, checksum: `sha256:demo-${id}`, createdAt: now, updatedAt: now, createdBy: agentId ?? "visible.general", sessionId, taskId, agentId, scope: "session", summary, provenance: { sourceCount: 2, representativeRefs: ["history:demo-session-01-m1", "task:task-demo-root"] } }); };
    artifact("artifact://demo-research", "research-report", "text/plain", 184_320, "Bounded research report; use range reads for the body.", "task-demo-research-a", "researcher");
    artifact("artifact://demo-result-json", "task-result", "application/json", 72_400, "Structured task result with source references.", "task-demo-coder", "coder");
    const tool = (name: string, namespace: string, description: string, permissions: string[], sideEffect: "read" | "write" | "destructive", concurrencySafe: boolean, loaded: boolean, source: "core" | "dynamic" | "ptc"): void => { this.tools.set(name, { name, namespace, description, permissions, sideEffect, concurrencySafe, schema: { type: "object", properties: { query: { type: "string" } } }, schemaTokens: name.length + 42, loaded, internal: false, discovery: { source } }); };
    tool("memory.search", "memory", "Search ranked long-term memories.", ["memory:read"], "read", true, true, "core"); tool("history.search", "history", "Search canonical History.", ["history:read"], "read", true, true, "core"); tool("artifact.query", "artifact", "Query bounded text snippets.", ["artifact:read"], "read", true, true, "core"); tool("artifact.read", "artifact", "Read a bounded byte range.", ["artifact:read"], "read", true, true, "core"); tool("state.patch", "state", "Patch mutable task state.", ["state:write"], "write", false, false, "dynamic"); tool("artifact.delete", "artifact", "Delete an artifact (destructive).", ["artifact:delete"], "destructive", false, false, "dynamic"); tool("run_code", "ptc", "Execute a bounded program through the PTC sandbox.", ["tool:execute"], "write", false, true, "ptc");
    const agent = (id: string, name: string, role: string, status: AgentSummaryDto["status"], modelProfile: string, permissions: string[], toolNames: string[], taskId?: string): void => { const summary = { id, name, role, status, sessionId, taskId, modelProfile, contextLimitTokens: role === "planner" ? 131_072 : 65_536, permissions, toolCount: toolNames.length, ptcEnabled: toolNames.includes("run_code"), tokensUsed: role === "planner" ? 8_420 : 2_140, durationMs: status === "completed" ? 1_280 : 0, budget: { maxModelCalls: 20, maxToolCalls: 100, maxPtcExecutions: 10, maxChildTasks: role === "planner" ? 8 : 0, maxTokens: 32_000 }, delegationDepth: role === "planner" ? 0 : 1, retryCount: 0 }; this.agents.set(id, { ...summary, instructionsPreview: `${name} is a bounded ${role} role.`, objective: role === "planner" ? "Coordinate a source-grounded implementation." : `Complete the ${role} assignment.`, loadedToolNames: toolNames, artifactIds: [...this.artifacts.keys()].filter((artifactId) => artifactId.includes(role === "researcher" ? "research" : "result")), memoryRefs: ["memory-typescript"], localStateKeys: ["objective", "progress"] }); };
    agent("visible.general", "Visible General", "visible", "idle", "default", ["memory:read", "history:read", "artifact:read", "tool:execute"], ["memory.search", "history.search", "context.inspect", "run_code"]);
    agent("planner", "Planner", "planner", "completed", "reasoning", ["memory:read", "history:read", "artifact:read", "tool:execute"], ["memory.search", "history.search", "artifact.query", "run_code"], "task-demo-root");
    agent("researcher", "Researcher", "researcher", "completed", "cheap", ["memory:read", "history:read", "artifact:read", "tool:execute"], ["memory.search", "history.search", "artifact.query", "artifact.read", "run_code"], "task-demo-research-a");
    agent("coder", "Coder", "coder", "completed", "coding", ["artifact:read", "artifact:write", "state:read", "state:write", "tool:execute"], ["artifact.query", "artifact.read", "state.patch", "run_code"], "task-demo-coder");
    agent("reviewer", "Reviewer", "reviewer", "waiting", "reasoning", ["artifact:read", "memory:read", "history:read", "state:read"], ["artifact.query", "memory.search"], "task-demo-review");
    agent("hidden.memory", "Hidden Memory", "hidden-memory", "idle", "memory", ["memory:read", "memory:write", "history:read"], ["memory.search", "history.search"]);
    const task = (id: string, objective: string, assignedAgentId: string, status: TaskSummaryDto["status"], dependencyIds: string[], parentTaskId?: string): void => { const summary = { id, parentTaskId, sessionId, createdBy: "planner", assignedAgentId, objective, status, createdAt: now, updatedAt: now, dependencyIds, childTaskIds: [], outputRefs: id.includes("research") ? ["artifact://demo-research"] : id.includes("coder") ? ["artifact://demo-result-json"] : [], retryCount: 0, reviewIteration: id.includes("review") ? 1 : 0, durationMs: status === "completed" ? 1_280 : 0 }; this.tasks.set(id, { ...summary, inputPreview: objective, outputPreview: status === "completed" ? "Completed with bounded references." : undefined, sharedState: { milestone: "console hardening", owner: assignedAgentId }, localSummary: "Read-only demo task summary.", handoffs: [], ...(status === "failed" ? { failure: { code: "demo_failure", message: "Demo task failed safely." } } : {}) }); };
    task("task-demo-root", "Coordinate a source-grounded implementation.", "planner", "completed", []); task("task-demo-research-a", "Inspect runtime artifacts and memory evidence.", "researcher", "completed", [], "task-demo-root"); task("task-demo-research-b", "Check tool and PTC activity.", "researcher", "completed", [], "task-demo-root"); task("task-demo-coder", "Prepare a bounded implementation result.", "coder", "completed", ["task-demo-research-a", "task-demo-research-b"], "task-demo-root"); task("task-demo-review", "Review the implementation result.", "reviewer", "waiting", ["task-demo-coder"], "task-demo-root"); task("task-demo-final", "Synthesize the reviewed result.", "planner", "pending", ["task-demo-review"], "task-demo-root");
    const timeline = [
      { id: "ptc-event-1", atMs: 0, kind: "started" as const, label: "PTC execution started", status: "running" as const },
      { id: "ptc-event-2", atMs: 18, kind: "tool_started" as const, label: "Parallel read batch", toolName: "memory.search", sideEffect: "read" as const, concurrency: 3, status: "running" as const },
      { id: "ptc-event-3", atMs: 62, kind: "barrier" as const, label: "Write barrier", sideEffect: "write" as const, concurrency: 1, status: "completed" as const },
      { id: "ptc-event-4", atMs: 88, kind: "tool_completed" as const, label: "Artifact handle returned", toolName: "artifact.query", sideEffect: "read" as const, concurrency: 2, durationMs: 26, status: "completed" as const },
      { id: "ptc-event-5", atMs: 112, kind: "completed" as const, label: "Final result externalized", durationMs: 112, status: "completed" as const },
    ];
    this.ptcExecutions.set("ptc-demo-01", { id: "ptc-demo-01", sessionId, agentId: "researcher", taskId: "task-demo-research-a", status: "completed", startedAt: now, completedAt: now, durationMs: 112, toolCalls: 6, peakConcurrency: 3, artifactSpills: 1, quotaUsed: 6, quotaLimit: 100, finalResultKind: "artifact", codePreview: "const results = await Promise.all([...queries].map(tools.memory.search));", timeline, resultPreview: "artifact://demo-research", artifactIds: ["artifact://demo-research"], permissions: ["memory:read", "artifact:read", "tool:execute"] });
  }
  private syncContext(sessionId: string): void {
    const current = this.contexts.get(sessionId); const session = this.sessions.get(sessionId); if (!current || !session) return;
    const recentRawTokens = Math.ceil(session.messages.reduce((sum, message) => sum + message.content.length, 0) / 4);
    const retrievedMemoryTokens = [...this.retrievalByMessage.values()].filter((entry) => entry.sessionId === sessionId).at(-1)?.results.length ? 1_200 : 0;
    const toolResultTokens = session.messages.some((message) => message.content.includes("[tool]") || message.content.includes("[ptc]")) ? 720 : 300;
    const usedTokens = current.stats.systemTokens + current.stats.pinnedTokens + recentRawTokens + current.stats.artifactHandleTokens + current.stats.toolSchemaTokens + retrievedMemoryTokens + toolResultTokens;
    const pressure = Math.min(1, (usedTokens + current.stats.generationReserveTokens) / current.stats.contextLimit);
    const level = pressure >= 0.92 ? "EMERGENCY" : pressure >= 0.85 ? "COMPACTION" : pressure >= 0.75 ? "HIGH" : pressure >= 0.6 ? "ELEVATED" : "NORMAL";
    const scale = level === "NORMAL" ? 1 : level === "ELEVATED" ? 0.9 : level === "HIGH" ? 0.7 : level === "COMPACTION" ? 0.5 : 0.35;
    const recommendations = level === "NORMAL" ? ["continue_normal"] : level === "ELEVATED" ? ["avoid_large_retrieval"] : level === "HIGH" ? ["prefer_ptc", "prefer_artifact", "limit_memory_retrieval", "unload_unused_dynamic_tools"] : ["prefer_ptc", "prefer_artifact", "limit_memory_retrieval", "request_compaction"];
    this.contexts.set(sessionId, contextInspectorDtoSchema.parse({ ...current, currentTurn: Math.max(1, session.messages.length), historyMessageCount: session.messages.length, stats: { ...current.stats, usedTokens, availableTokens: Math.max(0, current.stats.contextLimit - usedTokens), safeHeadroomTokens: Math.max(0, current.stats.contextLimit - usedTokens - current.stats.generationReserveTokens), recentRawTokens, retrievedMemoryTokens, toolResultTokens, pressure, pressureLevel: level }, policy: { ...current.policy, level, recommendations, enforced: level === "EMERGENCY", effectiveRecentRawTarget: Math.max(1, Math.floor(48_000 * scale)), effectiveRetrievalTokenBudget: Math.max(1, Math.floor(8_000 * scale)), effectiveToolSchemaBudget: Math.max(1, Math.floor(8_000 * scale)), effectiveToolResultBudget: Math.max(1, Math.floor(16_000 * scale)) }, retrievedMemoryCount: retrievedMemoryTokens ? 1 : 0 }));
  }
  private recordRetrieval(sessionId: string, messageId: string, query: string): void {
    const memory = query.toLocaleLowerCase().includes("postgres") ? this.memories.get("memory-postgres") : this.memories.get("memory-typescript");
    if (!memory) return;
    this.retrievalByMessage.set(`${sessionId}:${messageId}`, retrievalInspectorDtoSchema.parse({ sessionId, messageId, query, results: [{ memory, score: 0.87, rank: 1, matchedBy: ["lexical", "semantic"], signals: { lexical: 0.42, semantic: 0.31, confidence: 0.08, reinforcement: 0.06 } }], total: 1 }));
  }
  private seed(id: string, displayName: string, empty = false): SessionSummaryDto {
    const createdAt = new Date().toISOString(); const messages: ChatMessageDto[] = empty ? [] : [
      { id: `${id}-m1`, sessionId: id, role: "user", content: "Inspect the runtime foundation.", status: "completed", createdAt, updatedAt: createdAt },
      { id: `${id}-m2`, sessionId: id, role: "assistant", content: "The runtime is ready for observation.", status: "completed", createdAt, updatedAt: createdAt },
    ];
    const summary = sessionSummaryDtoSchema.parse({ id, createdAt, updatedAt: createdAt, status: "active", messageCount: messages.length, agentCount: 1, displayName }); this.sessions.set(id, { summary, messages }); this.seedInspectorFixtures(id); return summary;
  }
  private touch(session: DemoSession): void { session.summary = sessionSummaryDtoSchema.parse({ ...session.summary, updatedAt: new Date().toISOString(), messageCount: session.messages.length }); }
}

function chunkText(value: string, size: number): string[] { const chunks: string[] = []; for (let index = 0; index < value.length; index += size) chunks.push(value.slice(index, index + size)); return chunks; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function encodeCursor(offset: number): string { return Buffer.from(String(offset), "utf8").toString("base64url"); }
function decodeCursor(cursor: string | undefined): number { if (cursor === undefined) return 0; const value = Number(Buffer.from(cursor, "base64url").toString("utf8")); return Number.isInteger(value) && value >= 0 ? value : -1; }
function boundedText(value: string, max: number): string { return value.length <= max ? value : `${value.slice(0, max - 1)}…`; }
function notFound(message: string): Error & { statusCode: number; code: string } { const error = new Error(message) as Error & { statusCode: number; code: string }; error.statusCode = 404; error.code = "not_found"; return error; }
function badRequest(code: string, message: string): Error & { statusCode: number; code: string } { const error = new Error(message) as Error & { statusCode: number; code: string }; error.statusCode = 400; error.code = code; return error; }
