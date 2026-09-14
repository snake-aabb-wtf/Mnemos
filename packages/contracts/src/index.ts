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
