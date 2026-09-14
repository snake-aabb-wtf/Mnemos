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

// F3 read-only inspector contracts. These are intentionally bounded public DTOs;
// they do not expose ContextManager internals, raw tool payloads, or private memory
// implementation details.
export const contextPressureLevelDtoSchema = z.enum(["NORMAL", "ELEVATED", "HIGH", "COMPACTION", "EMERGENCY"]);
export const contextPolicyActionDtoSchema = z.enum([
  "continue_normal", "avoid_large_retrieval", "prefer_ptc", "prefer_artifact",
  "limit_memory_retrieval", "reduce_tool_result_budget", "unload_unused_dynamic_tools",
  "avoid_loading_more_tools", "request_compaction", "force_compaction",
  "do_not_invoke_model_until_context_reduced",
]);
export const contextStatsDtoSchema = z.object({
  usedTokens: z.number().int().nonnegative(), contextLimit: z.number().int().positive(),
  availableTokens: z.number().int().nonnegative(), safeHeadroomTokens: z.number().int().nonnegative(),
  systemTokens: z.number().int().nonnegative(), pinnedTokens: z.number().int().nonnegative(),
  recentRawTokens: z.number().int().nonnegative(), artifactHandleTokens: z.number().int().nonnegative(),
  toolSchemaTokens: z.number().int().nonnegative(), retrievedMemoryTokens: z.number().int().nonnegative(),
  toolResultTokens: z.number().int().nonnegative(), reservedTokens: z.number().int().nonnegative(),
  generationReserveTokens: z.number().int().nonnegative(), pressure: z.number().min(0).max(1),
  pressureLevel: contextPressureLevelDtoSchema, recentRawTargetTokens: z.number().int().positive(),
}).strict();
export type ContextStatsDto = z.infer<typeof contextStatsDtoSchema>;

export const contextPinDtoSchema = z.object({
  id: z.string().min(1), source: z.enum(["system", "automatic", "visible-agent"]),
  priority: z.enum(["critical", "normal", "low"]), tokenEstimate: z.number().int().nonnegative(),
  contentPreview: z.string().max(512), createdAt: z.string().datetime(), expiresAtTurn: z.number().int().positive().optional(),
  sessionId: z.string().min(1).optional(), sourceRange: z.object({
    firstMessageId: z.string().min(1), lastMessageId: z.string().min(1), messageCount: z.number().int().positive(),
  }).strict().optional(),
}).strict();
export type ContextPinDto = z.infer<typeof contextPinDtoSchema>;

export const contextPolicyDecisionDtoSchema = z.object({
  level: contextPressureLevelDtoSchema, recommendations: z.array(contextPolicyActionDtoSchema), enforced: z.boolean(),
  effectiveRecentRawTarget: z.number().int().positive(), effectiveRetrievalTokenBudget: z.number().int().positive(),
  effectiveToolSchemaBudget: z.number().int().positive(), effectiveToolResultBudget: z.number().int().positive(),
  generationReserveTokens: z.number().int().nonnegative(),
}).strict();
export type ContextPolicyDecisionDto = z.infer<typeof contextPolicyDecisionDtoSchema>;

export const compactionRecordDtoSchema = z.object({
  id: z.string().min(1), sessionId: z.string().min(1), createdAt: z.string().datetime(),
  kind: z.enum(["task", "turn", "tool-transaction", "message"]),
  sourceRange: z.object({ firstMessageId: z.string().min(1), lastMessageId: z.string().min(1), messageCount: z.number().int().positive() }).strict(),
  cutoffAfterMessageId: z.string().min(1), cutoffBeforeMessageId: z.string().min(1),
  evictedMessageCount: z.number().int().positive(), evictedTokens: z.number().int().nonnegative(),
  retainedTokens: z.number().int().nonnegative(), beforeTokens: z.number().int().nonnegative(), afterTokens: z.number().int().nonnegative(),
  automaticPinId: z.string().min(1), automaticPinPreview: z.string().max(512),
}).strict();
export type CompactionRecordDto = z.infer<typeof compactionRecordDtoSchema>;

export const contextInspectorDtoSchema = z.object({
  sessionId: z.string().min(1), currentTurn: z.number().int().nonnegative(), historyMessageCount: z.number().int().nonnegative(),
  stats: contextStatsDtoSchema, policy: contextPolicyDecisionDtoSchema,
  pins: z.array(contextPinDtoSchema).max(100), compactions: z.array(compactionRecordDtoSchema).max(100),
  retrievedMemoryCount: z.number().int().nonnegative(), loadedToolCount: z.number().int().nonnegative(),
}).strict();
export type ContextInspectorDto = z.infer<typeof contextInspectorDtoSchema>;

export const memoryTypeDtoSchema = z.enum(["semantic", "episodic", "decision", "preference", "entity"]);
export const memorySourceTypeDtoSchema = z.enum(["explicit_user_statement", "tool_observation", "assistant_inference", "derived_summary"]);
export const memoryStatusDtoSchema = z.enum(["active", "provisional", "superseded", "archived"]);
export const memorySummaryDtoSchema = z.object({
  id: z.string().min(1), type: memoryTypeDtoSchema, content: z.string().max(20_000),
  sourceIds: z.array(z.string().min(1)).max(500), sourceReferences: z.array(z.object({ sessionId: z.string().min(1), messageId: z.string().min(1) }).strict()).max(500),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), lastConfirmedAt: z.string().datetime().optional(),
  importance: z.number().min(0).max(1), confidence: z.number().min(0).max(1), sourceType: memorySourceTypeDtoSchema,
  status: memoryStatusDtoSchema, supersededBy: z.string().min(1).optional(), mergedInto: z.string().min(1).optional(),
  derivedFromMemoryIds: z.array(z.string().min(1)).max(500), confirmationCount: z.number().int().nonnegative(),
  reinforcementScore: z.number().min(0).max(1), stale: z.boolean(), staleSince: z.string().datetime().optional(),
  durability: z.enum(["durable", "normal", "ephemeral"]), scope: z.object({ kind: z.enum(["global", "user", "project", "session", "entity"]), id: z.string().min(1) }).strict(),
  entities: z.array(z.string().min(1)).max(100), tags: z.array(z.string().min(1)).max(100),
}).strict();
export type MemorySummaryDto = z.infer<typeof memorySummaryDtoSchema>;
export const memoryPageDtoSchema = z.object({ items: z.array(memorySummaryDtoSchema).max(100), nextCursor: z.string().min(1).optional(), total: z.number().int().nonnegative() }).strict();
export type MemoryPageDto = z.infer<typeof memoryPageDtoSchema>;
export const memoryInspectorQuerySchema = z.object({
  query: z.string().trim().max(240).default(""), type: memoryTypeDtoSchema.optional(), status: memoryStatusDtoSchema.optional(),
  sourceType: memorySourceTypeDtoSchema.optional(), scopeKind: z.enum(["global", "user", "project", "session", "entity"]).optional(),
  scopeId: z.string().trim().max(240).optional(), sessionId: z.string().trim().max(240).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20), cursor: z.string().min(1).max(256).optional(),
}).strict();
export type MemoryInspectorQuery = z.infer<typeof memoryInspectorQuerySchema>;
export const memoryDetailDtoSchema = memorySummaryDtoSchema.extend({
  timeline: z.array(memorySummaryDtoSchema).max(100),
  relatedMemoryIds: z.array(z.string().min(1)).max(100),
}).strict();
export type MemoryDetailDto = z.infer<typeof memoryDetailDtoSchema>;
export const memorySourceDtoSchema = z.object({ memoryId: z.string().min(1), sessionId: z.string().min(1), messageId: z.string().min(1), role: z.enum(["system", "user", "assistant", "tool"]), content: z.string().max(20_000), createdAt: z.string().datetime(), ordinal: z.number().int().nonnegative() }).strict();
export type MemorySourceDto = z.infer<typeof memorySourceDtoSchema>;
export const historyMessageDtoSchema = z.object({ id: z.string().min(1), sessionId: z.string().min(1), role: z.enum(["system", "user", "assistant", "tool"]), content: z.string().max(20_000), createdAt: z.string().datetime(), beforeId: z.string().min(1).optional(), afterId: z.string().min(1).optional() }).strict();
export type HistoryMessageDto = z.infer<typeof historyMessageDtoSchema>;
export const retrievalResultDtoSchema = z.object({ memory: memorySummaryDtoSchema, score: z.number(), rank: z.number().int().positive(), matchedBy: z.array(z.enum(["lexical", "semantic", "entity", "metadata", "temporal"])), signals: z.record(z.string(), z.number()) }).strict();
export type RetrievalResultDto = z.infer<typeof retrievalResultDtoSchema>;
export const retrievalInspectorDtoSchema = z.object({ sessionId: z.string().min(1), messageId: z.string().min(1), query: z.string().max(4_000), results: z.array(retrievalResultDtoSchema).max(20), total: z.number().int().nonnegative() }).strict();
export type RetrievalInspectorDto = z.infer<typeof retrievalInspectorDtoSchema>;

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
