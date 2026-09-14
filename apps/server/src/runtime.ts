import { randomUUID } from "node:crypto";
import { EventBus, RuntimeHealthService, type HarnessEventMap } from "@mnemos/core";
import {
  chatActivitySchema, chatGenerationDtoSchema, chatMessageDtoSchema, chatMessagesDtoSchema, chatStreamEventDtoSchema,
  metaDtoSchema, runtimeSummaryDtoSchema, sessionDetailDtoSchema, sessionPageDtoSchema, sessionSummaryDtoSchema,
  type ChatActivity, type ChatGenerationDto, type ChatMessageDto, type ChatMessagesDto, type ChatStreamEventDto,
  type CreateSessionInput, type MetaDto, type RuntimeSummaryDto, type SessionDetailDto, type SessionPageDto, type SessionSummaryDto,
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

interface DemoSession { summary: SessionSummaryDto; messages: ChatMessageDto[]; }
interface Generation {
  sessionId: string; id: string; assistantMessageId: string; controller: AbortController;
  events: ChatStreamEventDto[]; listeners: Set<(event: ChatStreamEventDto) => void>; nextSequence: number; done: boolean;
}

/** Deterministic offline runtime used by the Console demo and E2E suite. It
 * lives behind the same boundary as a real Harness adapter, so HTTP never
 * owns the agent loop or canonical message state. */
export class DemoConsoleRuntimeService implements ChatRuntimeService {
  readonly events = new EventBus<HarnessEventMap>();
  readonly health: RuntimeHealthService;
  private readonly startedAt = Date.now();
  private readonly sessions = new Map<string, DemoSession>();
  private readonly generations = new Map<string, Generation>();

  constructor(private readonly profile: "development" | "test" = "test") {
    this.health = new RuntimeHealthService([
      { name: "database", check: async () => ({ ok: true, detail: "demo in-memory store" }) },
      { name: "migrations", check: async () => ({ ok: true, detail: "demo schema ready" }) },
      { name: "artifact-store", check: async () => ({ ok: true, detail: "demo artifact adapter" }) },
      { name: "workers", check: async () => ({ ok: true, detail: "demo worker boundary" }) },
      { name: "sandbox", check: async () => ({ ok: true, detail: "demo sandbox adapter" }) },
    ], "0.1.0");
    this.seed("demo-session-01", "Console smoke session");
  }

  async meta(): Promise<MetaDto> { return metaDtoSchema.parse({ version: "0.1.0", apiVersion: "v1", schemaVersion: 1, serverTime: new Date().toISOString() }); }
  async summary(): Promise<RuntimeSummaryDto> {
    const activeSessions = [...this.sessions.values()].filter((session) => session.summary.status === "active").length;
    return runtimeSummaryDtoSchema.parse({ status: "ready", version: "0.1.0", uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000), sessionsCount: this.sessions.size, activeSessions, registeredAgents: 6, activeAgents: 0, queuedJobs: 0, runningPtcExecutions: [...this.generations.values()].filter((generation) => !generation.done).length, memoryCount: 0, artifactCount: 0, contextLimitTokens: 131_072, sandboxBackend: "demo", sandboxStatus: "available", profile: this.profile });
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

  async startGeneration(sessionId: string, content: string, retryOfMessageId?: string): Promise<ChatGenerationDto> {
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
  private finishCompleted(generation: Generation, session: DemoSession): void { const message = this.assistant(generation, session); if (!message) return; message.status = "completed"; message.updatedAt = new Date().toISOString(); this.touch(session); this.emitChat(generation, { type: "completed", messageId: message.id, message }); }
  private finishCancelled(generation: Generation, session: DemoSession): void { const message = this.assistant(generation, session); if (!message) return; message.status = "cancelled"; message.updatedAt = new Date().toISOString(); this.touch(session); this.emitChat(generation, { type: "cancelled", messageId: message.id, message }); }
  private finishFailed(generation: Generation, session: DemoSession, errorCode: string): void { const message = this.assistant(generation, session); if (!message) return; message.status = "failed"; message.updatedAt = new Date().toISOString(); this.touch(session); this.emitChat(generation, { type: "failed", messageId: message.id, message, errorCode }); }
  private assistant(generation: Generation, session: DemoSession): ChatMessageDto | undefined { return session.messages.find((item) => item.id === generation.assistantMessageId); }
  private retrySource(session: DemoSession, id: string | undefined): string { if (!id) return "Continue the previous request."; const index = session.messages.findIndex((item) => item.id === id); return session.messages.slice(0, index).reverse().find((item) => item.role === "user")?.content ?? "Continue the previous request."; }
  private emitChat(generation: Generation, partial: Omit<ChatStreamEventDto, "id" | "sessionId" | "generationId" | "sequence" | "timestamp">): void {
    if (generation.done && !["completed", "cancelled", "failed"].includes(partial.type)) return;
    const event = chatStreamEventDtoSchema.parse({ id: randomUUID(), sessionId: generation.sessionId, generationId: generation.id, sequence: generation.nextSequence++, timestamp: new Date().toISOString(), ...partial });
    generation.events.push(event); for (const listener of generation.listeners) { try { listener(event); } catch { /* observers cannot break runtime */ } }
    if (["completed", "cancelled", "failed"].includes(event.type)) { generation.done = true; generation.listeners.clear(); }
  }
  private seed(id: string, displayName: string, empty = false): SessionSummaryDto {
    const createdAt = new Date().toISOString(); const messages: ChatMessageDto[] = empty ? [] : [
      { id: `${id}-m1`, sessionId: id, role: "user", content: "Inspect the runtime foundation.", status: "completed", createdAt, updatedAt: createdAt },
      { id: `${id}-m2`, sessionId: id, role: "assistant", content: "The runtime is ready for observation.", status: "completed", createdAt, updatedAt: createdAt },
    ];
    const summary = sessionSummaryDtoSchema.parse({ id, createdAt, updatedAt: createdAt, status: "active", messageCount: messages.length, agentCount: 1, displayName }); this.sessions.set(id, { summary, messages }); return summary;
  }
  private touch(session: DemoSession): void { session.summary = sessionSummaryDtoSchema.parse({ ...session.summary, updatedAt: new Date().toISOString(), messageCount: session.messages.length }); }
}

function chunkText(value: string, size: number): string[] { const chunks: string[] = []; for (let index = 0; index < value.length; index += size) chunks.push(value.slice(index, index + size)); return chunks; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function encodeCursor(offset: number): string { return Buffer.from(String(offset), "utf8").toString("base64url"); }
function decodeCursor(cursor: string | undefined): number { if (cursor === undefined) return 0; const value = Number(Buffer.from(cursor, "base64url").toString("utf8")); return Number.isInteger(value) && value >= 0 ? value : -1; }
function notFound(message: string): Error & { statusCode: number; code: string } { const error = new Error(message) as Error & { statusCode: number; code: string }; error.statusCode = 404; error.code = "not_found"; return error; }
function badRequest(code: string, message: string): Error & { statusCode: number; code: string } { const error = new Error(message) as Error & { statusCode: number; code: string }; error.statusCode = 400; error.code = code; return error; }
