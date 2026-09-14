import { z } from "zod";

export const apiVersion = "v1" as const;
export const apiVersionSchema = z.literal(apiVersion);

export const apiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  requestId: z.string().min(1).optional(),
  details: z.unknown().optional(),
}).strict();
export type ApiError = z.infer<typeof apiErrorSchema>;

export const apiErrorResponseSchema = z.object({ error: apiErrorSchema }).strict();
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(256).optional(),
}).strict();

export const paginationSchema = z.object({
  nextCursor: z.string().min(1).optional(),
}).strict();

export const metaDtoSchema = z.object({
  version: z.string().min(1),
  apiVersion: apiVersionSchema,
  schemaVersion: z.number().int().nonnegative().optional(),
  serverTime: z.string().datetime(),
}).strict();
export type MetaDto = z.infer<typeof metaDtoSchema>;

export const healthDtoSchema = z.object({
  status: z.literal("ok"),
  version: z.string().min(1),
  uptimeSeconds: z.number().nonnegative(),
}).strict();
export type HealthDto = z.infer<typeof healthDtoSchema>;

export const readinessCheckDtoSchema = z.object({
  name: z.string().min(1),
  ok: z.boolean(),
  detail: z.string().max(512).optional(),
}).strict();

export const readinessDtoSchema = z.object({
  status: z.enum(["ok", "not_ready"]),
  checks: z.array(readinessCheckDtoSchema),
  generatedAt: z.string().datetime(),
}).strict();
export type ReadinessDto = z.infer<typeof readinessDtoSchema>;

export const runtimeSummaryDtoSchema = z.object({
  status: z.enum(["ready", "not_ready", "degraded"]),
  version: z.string().min(1),
  uptimeSeconds: z.number().nonnegative(),
  sessionsCount: z.number().int().nonnegative().optional(),
  activeSessions: z.number().int().nonnegative().optional(),
  registeredAgents: z.number().int().nonnegative().optional(),
  activeAgents: z.number().int().nonnegative().optional(),
  queuedJobs: z.number().int().nonnegative().optional(),
  runningPtcExecutions: z.number().int().nonnegative().optional(),
  memoryCount: z.number().int().nonnegative().optional(),
  artifactCount: z.number().int().nonnegative().optional(),
  contextLimitTokens: z.number().int().positive().optional(),
  sandboxBackend: z.string().max(128).optional(),
  sandboxStatus: z.enum(["available", "unavailable", "unknown"]).optional(),
  profile: z.enum(["development", "test", "production"]).optional(),
}).strict();
export type RuntimeSummaryDto = z.infer<typeof runtimeSummaryDtoSchema>;

export const sessionStatusSchema = z.enum(["active", "idle", "completed", "failed", "unknown"]);
export const sessionParamsSchema = z.object({ sessionId: z.string().min(1).max(256) }).strict();
export type SessionParams = z.infer<typeof sessionParamsSchema>;
export const sessionSummaryDtoSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  status: sessionStatusSchema,
  messageCount: z.number().int().nonnegative(),
  agentCount: z.number().int().nonnegative().optional(),
  displayName: z.string().max(160).optional(),
}).strict();
export type SessionSummaryDto = z.infer<typeof sessionSummaryDtoSchema>;

export const publicMessageDtoSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "tool"]),
  preview: z.string().max(512),
  createdAt: z.string().datetime(),
}).strict();
export type PublicMessageDto = z.infer<typeof publicMessageDtoSchema>;

export const sessionDetailDtoSchema = sessionSummaryDtoSchema.extend({
  recentMessages: z.array(publicMessageDtoSchema).max(20),
  activeAgentIds: z.array(z.string().min(1)).max(50).optional(),
  taskSummary: z.object({
    pending: z.number().int().nonnegative().optional(),
    running: z.number().int().nonnegative().optional(),
    completed: z.number().int().nonnegative().optional(),
    failed: z.number().int().nonnegative().optional(),
  }).strict().optional(),
}).strict();
export type SessionDetailDto = z.infer<typeof sessionDetailDtoSchema>;

export const sessionPageDtoSchema = z.object({
  items: z.array(sessionSummaryDtoSchema),
  nextCursor: z.string().min(1).optional(),
}).strict();
export type SessionPageDto = z.infer<typeof sessionPageDtoSchema>;

/** Public conversational message. The server intentionally exposes only the
 * model-visible content and bounded runtime metadata; canonical History stays
 * behind the runtime adapter. */
export const chatMessageRoleSchema = z.enum(["user", "assistant", "tool"]);
export const chatMessageStatusSchema = z.enum(["completed", "streaming", "cancelled", "failed"]);
export const chatMessageDtoSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  role: chatMessageRoleSchema,
  content: z.string().max(256_000),
  status: chatMessageStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  generationId: z.string().min(1).optional(),
  attempt: z.number().int().positive().optional(),
  retryOfMessageId: z.string().min(1).optional(),
}).strict();
export type ChatMessageDto = z.infer<typeof chatMessageDtoSchema>;

export const createSessionInputSchema = z.object({
  displayName: z.string().trim().min(1).max(160).optional(),
}).strict();
export type CreateSessionInput = z.infer<typeof createSessionInputSchema>;

export const chatSendInputSchema = z.object({
  content: z.string().trim().min(1).max(32_000),
}).strict();
export type ChatSendInput = z.infer<typeof chatSendInputSchema>;

export const chatMessagesDtoSchema = z.object({
  sessionId: z.string().min(1),
  items: z.array(chatMessageDtoSchema).max(1_000),
  nextCursor: z.string().min(1).optional(),
}).strict();
export type ChatMessagesDto = z.infer<typeof chatMessagesDtoSchema>;

export const chatGenerationDtoSchema = z.object({
  sessionId: z.string().min(1),
  generationId: z.string().min(1),
  userMessageId: z.string().min(1),
  assistantMessageId: z.string().min(1),
  status: z.literal("started"),
}).strict();
export type ChatGenerationDto = z.infer<typeof chatGenerationDtoSchema>;

export const chatStreamEventTypeSchema = z.enum(["started", "text_delta", "activity", "completed", "cancelled", "failed"]);
export type ChatStreamEventType = z.infer<typeof chatStreamEventTypeSchema>;
export const chatActivitySchema = z.object({
  kind: z.enum(["memory", "tool", "ptc", "context", "generation"]),
  label: z.string().min(1).max(160),
}).strict();
export type ChatActivity = z.infer<typeof chatActivitySchema>;
export const chatStreamEventDtoSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  generationId: z.string().min(1),
  type: chatStreamEventTypeSchema,
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
  messageId: z.string().min(1).optional(),
  delta: z.string().max(8_192).optional(),
  activity: chatActivitySchema.optional(),
  message: chatMessageDtoSchema.optional(),
  errorCode: z.string().min(1).max(96).optional(),
}).strict();
export type ChatStreamEventDto = z.infer<typeof chatStreamEventDtoSchema>;
export const chatCancelResponseSchema = z.object({ status: z.literal("cancelling"), generationId: z.string().min(1) }).strict();
export type ChatCancelResponse = z.infer<typeof chatCancelResponseSchema>;

export const runtimeEventTypeSchema = z.enum([
  "runtime.started", "runtime.ready", "runtime.shutting_down", "runtime.stopped",
  "message.received", "message.generated",
  "context.pressure.changed", "context.compaction.requested", "context.evicted",
  "memory.created", "memory.updated", "memory.superseded",
  "tool.called", "tool.completed", "tool.failed",
  "ptc.started", "ptc.completed", "ptc.failed",
  "agent.started", "agent.completed", "agent.failed",
  "task.created", "task.started", "task.completed", "task.failed", "task.cancelled",
  "agent.handoff",
]);
export type RuntimeEventType = z.infer<typeof runtimeEventTypeSchema>;

export const runtimeEventDtoSchema = z.object({
  id: z.string().min(1),
  type: runtimeEventTypeSchema,
  timestamp: z.string().datetime(),
  sessionId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  payload: z.record(z.string(), z.unknown()),
}).strict();
export type RuntimeEventDto = z.infer<typeof runtimeEventDtoSchema>;

export const demoSessionResponseSchema = z.object({
  session: sessionSummaryDtoSchema,
}).strict();
export type DemoSessionResponse = z.infer<typeof demoSessionResponseSchema>;
