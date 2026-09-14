import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import {
  apiErrorResponseSchema,
  apiVersion,
  chatMessagesDtoSchema,
  chatGenerationDtoSchema,
  chatSendInputSchema,
  chatStreamEventDtoSchema,
  createSessionInputSchema,
  demoSessionResponseSchema,
  healthDtoSchema,
  metaDtoSchema,
  paginationQuerySchema,
  readinessDtoSchema,
  runtimeEventDtoSchema,
  runtimeEventTypeSchema,
  runtimeSummaryDtoSchema,
  sessionParamsSchema,
  sessionDetailDtoSchema,
  sessionPageDtoSchema,
  sessionSummaryDtoSchema,
  type RuntimeEventDto,
  type RuntimeEventType,
} from "@mnemos/contracts";
import type { HarnessEventMap } from "@mnemos/core";
import { DemoConsoleRuntimeService, type ChatRuntimeService, type ConsoleRuntimeService } from "./runtime.js";

export interface WebAccessPolicy {
  profile?: "development" | "test" | "production";
  allowedOrigins?: readonly string[];
  allowDemoSession?: boolean;
}

export interface ServerOptions {
  runtime: ConsoleRuntimeService;
  access?: WebAccessPolicy;
  logger?: boolean;
}

export interface CreateServerOptions extends Partial<ServerOptions> {
  runtime?: ConsoleRuntimeService;
}

const publicEventTypes: readonly RuntimeEventType[] = [
  "runtime.started", "runtime.ready", "runtime.shutting_down", "runtime.stopped",
  "message.received", "message.generated", "context.pressure.changed", "context.compaction.requested", "context.evicted",
  "memory.created", "memory.updated", "memory.superseded", "tool.called", "tool.completed", "tool.failed",
  "ptc.started", "ptc.completed", "ptc.failed", "agent.started", "agent.completed", "agent.failed",
  "task.created", "task.started", "task.completed", "task.failed", "task.cancelled", "agent.handoff",
];

export async function createServer(options: CreateServerOptions = {}): Promise<FastifyInstance> {
  const profile = options.access?.profile ?? "test";
  const runtime = options.runtime ?? new DemoConsoleRuntimeService(profile === "production" ? "test" : profile);
  const allowDemoSession = options.access?.allowDemoSession ?? profile !== "production";
  const allowedOrigins = options.access?.allowedOrigins ?? (profile === "production" ? [] : ["http://localhost:5173"]);
  const app = Fastify({ logger: options.logger ?? false, genReqId: (request) => request.headers["x-request-id"]?.toString() || randomUUID() });

  await app.register(cors, {
    origin: (origin, callback) => callback(null, origin === undefined || allowedOrigins.includes(origin)),
    credentials: false,
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.setErrorHandler((error, request, reply) => {
    const status = error as { statusCode?: number; message?: string };
    const statusCode = isZodError(error) ? 400 : status.statusCode && status.statusCode >= 400 && status.statusCode < 500 ? status.statusCode : 500;
    const body = apiErrorResponseSchema.parse({ error: {
      code: statusCode === 400 ? "invalid_request" : statusCode === 404 ? "not_found" : "internal_error",
      message: statusCode === 500 ? "The server could not complete the request." : status.message ?? "Request failed.",
      requestId: request.id,
    } });
    reply.code(statusCode).send(body);
  });

  app.get(`/api/${apiVersion}/meta`, async (request, reply) => sendDto(reply, metaDtoSchema, await runtime.meta()));
  app.get(`/api/${apiVersion}/health`, async (_request, reply) => sendDto(reply, healthDtoSchema, runtime.health.liveness()));
  app.get(`/api/${apiVersion}/ready`, async (_request, reply) => {
    const readiness = readinessDtoSchema.parse(await runtime.health.readiness());
    return reply.code(readiness.status === "ok" ? 200 : 503).send(readiness);
  });
  app.get(`/api/${apiVersion}/runtime/summary`, async (_request, reply) => sendDto(reply, runtimeSummaryDtoSchema, await runtime.summary()));
  app.get(`/api/${apiVersion}/sessions`, async (request, reply) => {
    const query = paginationQuerySchema.parse(request.query);
    if (query.cursor !== undefined && decodeCursor(query.cursor) < 0) throw httpError(400, "invalid_request", "Invalid cursor.");
    return sendDto(reply, sessionPageDtoSchema, await runtime.listSessions(query));
  });
  app.get<{ Params: { sessionId: string } }>(`/api/${apiVersion}/sessions/:sessionId`, async (request, reply) => {
    const sessionId = routeId(request.params.sessionId, "session");
    const session = await runtime.getSession(sessionId);
    if (session === undefined) throw httpError(404, "not_found", "Session not found.");
    return sendDto(reply, sessionDetailDtoSchema, session);
  });
  app.post(`/api/${apiVersion}/sessions`, async (request, reply) => {
    const chat = requireChatRuntime(runtime);
    const input = createSessionInputSchema.parse(request.body ?? {});
    return sendDto(reply.code(201), sessionSummaryDtoSchema, await chat.createSession(input));
  });
  app.get<{ Params: { sessionId: string } }>(`/api/${apiVersion}/sessions/:sessionId/messages`, async (request, reply) => {
    const chat = requireChatRuntime(runtime);
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const query = paginationQuerySchema.parse(request.query);
    if (query.cursor !== undefined && decodeCursor(query.cursor) < 0) throw httpError(400, "invalid_request", "Invalid cursor.");
    const messages = await chat.listMessages(sessionId, query);
    if (messages === undefined) throw httpError(404, "not_found", "Session not found.");
    return sendDto(reply, chatMessagesDtoSchema, messages);
  });
  app.post<{ Params: { sessionId: string } }>(`/api/${apiVersion}/sessions/:sessionId/messages`, async (request, reply) => {
    const chat = requireChatRuntime(runtime);
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const input = chatSendInputSchema.parse(request.body);
    return sendDto(reply.code(202), chatGenerationDtoSchema, await chat.startGeneration(sessionId, input.content));
  });
  app.post<{ Params: { sessionId: string; messageId: string } }>(`/api/${apiVersion}/sessions/:sessionId/messages/:messageId/retry`, async (request, reply) => {
    const chat = requireChatRuntime(runtime);
    const sessionId = routeId(request.params.sessionId, "session");
    const messageId = routeId(request.params.messageId, "message");
    return sendDto(reply.code(202), chatGenerationDtoSchema, await chat.startGeneration(sessionId, "", messageId));
  });
  app.post<{ Params: { sessionId: string; generationId: string } }>(`/api/${apiVersion}/sessions/:sessionId/generations/:generationId/cancel`, async (request, reply) => {
    const chat = requireChatRuntime(runtime);
    const sessionId = routeId(request.params.sessionId, "session");
    const generationId = routeId(request.params.generationId, "generation");
    const cancelled = await chat.cancelGeneration(sessionId, generationId);
    if (!cancelled) throw httpError(409, "generation_not_active", "Generation is no longer active.");
    return reply.send({ status: "cancelling", generationId });
  });
  app.get<{ Params: { sessionId: string; generationId: string } }>(`/api/${apiVersion}/sessions/:sessionId/generations/:generationId/events`, (request, reply) => {
    const chat = requireChatRuntime(runtime);
    const sessionId = routeId(request.params.sessionId, "session");
    const generationId = routeId(request.params.generationId, "generation");
    return openChatStream(chat, sessionId, generationId, request, reply);
  });
  app.post(`/api/${apiVersion}/dev/demo-session`, async (_request, reply) => {
    if (!allowDemoSession || runtime.createDemoSession === undefined) throw httpError(404, "not_found", "Demo session is disabled.");
    const session = await runtime.createDemoSession();
    return sendDto(reply.code(201), demoSessionResponseSchema, { session });
  });
  app.get(`/api/${apiVersion}/events`, (request, reply) => openEventStream(runtime, request, reply));

  return app;
}

export async function main(): Promise<void> {
  const profile = (process.env.MNEMOS_PROFILE as WebAccessPolicy["profile"] | undefined) ?? "development";
  const port = Number(process.env.MNEMOS_SERVER_PORT ?? 4317);
  const host = process.env.MNEMOS_SERVER_HOST ?? "127.0.0.1";
  const app = await createServer({ access: { profile } });
  await app.listen({ port, host });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();

function sendDto<T>(reply: FastifyReply, schema: { parse(value: unknown): T }, value: unknown): FastifyReply {
  return reply.send(schema.parse(value));
}

function httpError(statusCode: number, code: string, message: string): Error & { statusCode: number; code: string } {
  const error = new Error(message) as Error & { statusCode: number; code: string };
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function isZodError(error: unknown): error is { issues: readonly unknown[]; message: string } {
  return typeof error === "object" && error !== null && "issues" in error && Array.isArray((error as { issues?: unknown }).issues);
}

function openEventStream(runtime: ConsoleRuntimeService, request: FastifyRequest, reply: FastifyReply): void {
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-request-id": request.id,
  });
  response.write(": mnemos event stream connected\n\n");
  let closed = false;
  const cleanups = publicEventTypes.map((type) => subscribe(runtime, type, (payload) => {
    if (closed) return;
    const event = safeRuntimeEvent(type, payload);
    if (event === undefined) return;
    try {
      response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } catch { close(); }
  }));
  const heartbeat = setInterval(() => { if (!closed) response.write(`: heartbeat ${Date.now()}\n\n`); }, 15_000);
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const cleanup of cleanups) cleanup();
    if (!response.destroyed) response.end();
  };
  request.raw.on("close", close);
}

function subscribe(runtime: ConsoleRuntimeService, type: RuntimeEventType, listener: (payload: unknown) => void): () => void {
  return runtime.events.on(type as keyof HarnessEventMap, listener as never);
}

function safeRuntimeEvent(type: RuntimeEventType, raw: unknown): RuntimeEventDto | undefined {
  if (!runtimeEventTypeSchema.safeParse(type).success) return undefined;
  const payload = safePayload(type, raw as Record<string, unknown>);
  const sessionId = stringField(raw, "sessionId");
  const agentId = stringField(raw, "agentId");
  const taskId = stringField(raw, "taskId");
  const event = runtimeEventDtoSchema.safeParse({ id: randomUUID(), type, timestamp: new Date().toISOString(), ...(sessionId ? { sessionId } : {}), ...(agentId ? { agentId } : {}), ...(taskId ? { taskId } : {}), payload });
  return event.success ? event.data : undefined;
}

function safePayload(type: RuntimeEventType, raw: Record<string, unknown>): Record<string, unknown> {
  const pick = (keys: readonly string[]): Record<string, unknown> => Object.fromEntries(keys.filter((key) => raw[key] !== undefined).map((key) => [key, boundedValue(raw[key])]));
  const keysByType: Partial<Record<RuntimeEventType, readonly string[]>> = {
    "runtime.started": ["runtimeVersion", "profile"], "runtime.ready": ["runtimeVersion", "schemaVersion"],
    "runtime.shutting_down": ["reason", "gracePeriodMs"], "runtime.stopped": ["durationMs"],
    "message.received": ["messageId", "role"], "message.generated": ["messageId", "role"],
    "context.pressure.changed": ["previous", "stats"], "context.compaction.requested": ["reason", "stats"], "context.evicted": ["sourceRange", "cutoffMessageId", "nextRetainedMessageId"],
    "memory.created": ["jobId", "memoryId"], "memory.updated": ["jobId", "memoryId"], "memory.superseded": ["jobId", "supersededId", "replacementId"],
    "tool.called": ["callId", "toolName", "status"], "tool.completed": ["callId", "toolName", "durationMs", "status", "outputKind"], "tool.failed": ["callId", "toolName", "durationMs", "status", "errorCode"],
    "ptc.started": ["executionId"], "ptc.completed": ["executionId", "durationMs", "toolCallCount", "peakConcurrency", "status"], "ptc.failed": ["executionId", "durationMs", "toolCallCount", "status", "errorCode"],
    "agent.started": ["instanceId"], "agent.completed": ["instanceId", "status"], "agent.failed": ["instanceId", "errorCode"],
    "task.created": ["parentTaskId"], "task.started": ["attempt"], "task.completed": [], "task.failed": ["errorCode"], "task.cancelled": ["reason"],
    "agent.handoff": ["messageId", "senderAgentId", "receiverAgentId", "tokenEstimate", "artifactCount", "memoryCount"],
  };
  const value = pick(keysByType[type] ?? []);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") <= 4_096) return value;
  return { truncated: true, eventType: type, keys: Object.keys(value) };
}

function boundedValue(value: unknown): unknown {
  if (typeof value === "string") return value.length > 512 ? `${value.slice(0, 509)}…` : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(boundedValue);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, item]) => [key, boundedValue(item)]));
  return undefined;
}

function stringField(raw: unknown, key: string): string | undefined {
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
}

function decodeCursor(cursor: string): number {
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isInteger(value) && value >= 0 ? value : -1;
}

function routeId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) throw httpError(400, "invalid_request", `Invalid ${label} id.`);
  return value;
}

function requireChatRuntime(runtime: ConsoleRuntimeService): ChatRuntimeService {
  if ("createSession" in runtime && typeof runtime.createSession === "function" && "startGeneration" in runtime && typeof runtime.startGeneration === "function") return runtime as ChatRuntimeService;
  throw httpError(503, "chat_unavailable", "Chat runtime is not configured.");
}

function openChatStream(runtime: ChatRuntimeService, sessionId: string, generationId: string, request: FastifyRequest, reply: FastifyReply): void {
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-request-id": request.id });
  response.write(": mnemos chat stream connected\n\n");
  let closed = false;
  let unsubscribe = (): void => undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const close = (): void => { if (closed) return; closed = true; if (heartbeat !== undefined) clearInterval(heartbeat); unsubscribe(); if (!response.destroyed) response.end(); };
  heartbeat = setInterval(() => { if (!closed) response.write(`: heartbeat ${Date.now()}\n\n`); }, 15_000);
  unsubscribe = runtime.subscribeGeneration(sessionId, generationId, (event) => {
    if (closed) return;
    const parsed = chatStreamEventDtoSchema.safeParse(event);
    if (!parsed.success) return;
    try {
      response.write(`id: ${parsed.data.id}\nevent: chat.${parsed.data.type}\ndata: ${JSON.stringify(parsed.data)}\n\n`);
      if (["completed", "cancelled", "failed"].includes(parsed.data.type)) close();
    } catch { close(); }
  });
  const closeWithHeartbeat = (): void => close();
  request.raw.on("close", closeWithHeartbeat);
}
