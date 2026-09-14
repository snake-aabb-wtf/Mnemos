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

// F4–F6 read-only Console contracts. These DTOs intentionally expose bounded
// metadata and references, never raw tool output, prompts, secrets, or hidden
// reasoning. Production adapters map their stores into the same shapes.
export const artifactSummaryDtoSchema = z.object({
  id: z.string().min(1).max(256), type: z.string().min(1).max(128), mimeType: z.string().max(255).optional(),
  sizeBytes: z.number().int().nonnegative(), checksum: z.string().max(256).optional(), createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(), createdBy: z.string().max(128).optional(), sessionId: z.string().max(256).optional(),
  taskId: z.string().max(256).optional(), agentId: z.string().max(256).optional(), scope: z.enum(["session", "persistent"]),
  expiresAt: z.string().datetime().optional(), summary: z.string().max(512).optional(), provenance: z.object({ sourceCount: z.number().int().nonnegative().max(100_000), representativeRefs: z.array(z.string().max(256)).max(12) }).strict().optional(),
}).strict();
export type ArtifactSummaryDto = z.infer<typeof artifactSummaryDtoSchema>;
export const artifactPageDtoSchema = z.object({ items: z.array(artifactSummaryDtoSchema).max(100), nextCursor: z.string().min(1).optional(), total: z.number().int().nonnegative() }).strict();
export type ArtifactPageDto = z.infer<typeof artifactPageDtoSchema>;
export const artifactQueryDtoSchema = z.object({ artifactId: z.string().min(1), byteOffset: z.number().int().nonnegative(), lineNumber: z.number().int().positive(), preview: z.string().max(2_000) }).strict();
export type ArtifactQueryDto = z.infer<typeof artifactQueryDtoSchema>;
export const artifactDetailDtoSchema = artifactSummaryDtoSchema.extend({ preview: z.object({ encoding: z.enum(["utf8", "json", "binary"]), content: z.string().max(16_384), truncated: z.boolean() }).strict().optional(), range: z.object({ offset: z.number().int().nonnegative(), length: z.number().int().nonnegative(), content: z.string().max(16_384), truncated: z.boolean() }).strict().optional(), queryMatches: z.array(artifactQueryDtoSchema).max(50).optional() }).strict();
export type ArtifactDetailDto = z.infer<typeof artifactDetailDtoSchema>;
export const artifactInspectorQuerySchema = paginationQuerySchema.extend({ query: z.string().trim().max(240).default(""), mimeType: z.string().trim().max(255).optional(), sessionId: z.string().trim().max(256).optional(), taskId: z.string().trim().max(256).optional(), agentId: z.string().trim().max(256).optional() }).strict();
export type ArtifactInspectorQuery = z.infer<typeof artifactInspectorQuerySchema>;

export const toolSummaryDtoSchema = z.object({ name: z.string().min(1).max(256), namespace: z.string().min(1).max(128), description: z.string().max(1_000), permissions: z.array(z.string().max(128)).max(32), sideEffect: z.enum(["read", "write", "destructive"]), concurrencySafe: z.boolean(), schema: z.record(z.string(), z.unknown()), schemaTokens: z.number().int().nonnegative(), loaded: z.boolean(), internal: z.boolean(), discovery: z.object({ source: z.enum(["core", "dynamic", "ptc"]), matchedBy: z.array(z.string().max(64)).max(12).optional(), lastLoadedAt: z.string().datetime().optional() }).strict() }).strict();
export type ToolSummaryDto = z.infer<typeof toolSummaryDtoSchema>;
export const toolPageDtoSchema = z.object({ items: z.array(toolSummaryDtoSchema).max(100), nextCursor: z.string().min(1).optional(), total: z.number().int().nonnegative(), loadedCount: z.number().int().nonnegative() }).strict();
export type ToolPageDto = z.infer<typeof toolPageDtoSchema>;
export const toolInspectorQuerySchema = paginationQuerySchema.extend({ query: z.string().trim().max(240).default(""), namespace: z.string().trim().max(128).optional(), loaded: z.coerce.boolean().optional() }).strict();
export type ToolInspectorQuery = z.infer<typeof toolInspectorQuerySchema>;

export const ptcTimelineEventDtoSchema = z.object({ id: z.string().min(1), atMs: z.number().int().nonnegative(), kind: z.enum(["started", "tool_started", "tool_completed", "barrier", "completed", "failed"]), label: z.string().max(240), toolName: z.string().max(256).optional(), sideEffect: z.enum(["read", "write", "destructive"]).optional(), concurrency: z.number().int().nonnegative().optional(), durationMs: z.number().int().nonnegative().optional(), status: z.enum(["running", "completed", "failed"]).optional() }).strict();
export type PtcTimelineEventDto = z.infer<typeof ptcTimelineEventDtoSchema>;
export const ptcExecutionSummaryDtoSchema = z.object({ id: z.string().min(1), sessionId: z.string().min(1), agentId: z.string().min(1), taskId: z.string().max(256).optional(), status: z.enum(["running", "completed", "failed", "cancelled"]), startedAt: z.string().datetime(), completedAt: z.string().datetime().optional(), durationMs: z.number().int().nonnegative(), toolCalls: z.number().int().nonnegative(), peakConcurrency: z.number().int().nonnegative(), artifactSpills: z.number().int().nonnegative(), quotaUsed: z.number().int().nonnegative(), quotaLimit: z.number().int().positive(), failureCode: z.string().max(128).optional(), finalResultKind: z.enum(["inline", "artifact", "none"]).optional() }).strict();
export type PtcExecutionSummaryDto = z.infer<typeof ptcExecutionSummaryDtoSchema>;
export const ptcExecutionDetailDtoSchema = ptcExecutionSummaryDtoSchema.extend({ codePreview: z.string().max(1_000).optional(), timeline: z.array(ptcTimelineEventDtoSchema).max(500), resultPreview: z.string().max(4_000).optional(), artifactIds: z.array(z.string().max(256)).max(50), permissions: z.array(z.string().max(128)).max(32) }).strict();
export type PtcExecutionDetailDto = z.infer<typeof ptcExecutionDetailDtoSchema>;
export const ptcPageDtoSchema = z.object({ items: z.array(ptcExecutionSummaryDtoSchema).max(100), nextCursor: z.string().min(1).optional(), total: z.number().int().nonnegative() }).strict();
export type PtcPageDto = z.infer<typeof ptcPageDtoSchema>;

export const agentSummaryDtoSchema = z.object({ id: z.string().min(1), name: z.string().min(1).max(128), role: z.string().max(128), status: z.enum(["idle", "running", "waiting", "completed", "failed", "cancelled"]), sessionId: z.string().max(256).optional(), taskId: z.string().max(256).optional(), modelProfile: z.string().max(128), contextLimitTokens: z.number().int().positive(), permissions: z.array(z.string().max(128)).max(64), toolCount: z.number().int().nonnegative(), ptcEnabled: z.boolean(), tokensUsed: z.number().int().nonnegative(), durationMs: z.number().int().nonnegative(), budget: z.object({ maxModelCalls: z.number().int().nonnegative(), maxToolCalls: z.number().int().nonnegative(), maxPtcExecutions: z.number().int().nonnegative(), maxChildTasks: z.number().int().nonnegative(), maxTokens: z.number().int().nonnegative() }).strict(), delegationDepth: z.number().int().nonnegative(), retryCount: z.number().int().nonnegative() }).strict();
export type AgentSummaryDto = z.infer<typeof agentSummaryDtoSchema>;
export const agentDetailDtoSchema = agentSummaryDtoSchema.extend({ instructionsPreview: z.string().max(512), objective: z.string().max(1_000).optional(), loadedToolNames: z.array(z.string().max(256)).max(100), artifactIds: z.array(z.string().max(256)).max(50), memoryRefs: z.array(z.string().max(256)).max(50), localStateKeys: z.array(z.string().max(128)).max(100) }).strict();
export type AgentDetailDto = z.infer<typeof agentDetailDtoSchema>;
export const agentPageDtoSchema = z.object({ items: z.array(agentSummaryDtoSchema).max(100), nextCursor: z.string().min(1).optional(), total: z.number().int().nonnegative() }).strict();
export type AgentPageDto = z.infer<typeof agentPageDtoSchema>;

export const taskStatusDtoSchema = z.enum(["pending", "running", "waiting", "completed", "failed", "cancelled", "blocked"]);
export const taskSummaryDtoSchema = z.object({ id: z.string().min(1), parentTaskId: z.string().max(256).optional(), sessionId: z.string().min(1), createdBy: z.string().min(1), assignedAgentId: z.string().max(256).optional(), objective: z.string().max(1_000), status: taskStatusDtoSchema, createdAt: z.string().datetime(), updatedAt: z.string().datetime(), dependencyIds: z.array(z.string().max(256)).max(100), childTaskIds: z.array(z.string().max(256)).max(100), outputRefs: z.array(z.string().max(256)).max(50), retryCount: z.number().int().nonnegative(), reviewIteration: z.number().int().nonnegative(), durationMs: z.number().int().nonnegative() }).strict();
export type TaskSummaryDto = z.infer<typeof taskSummaryDtoSchema>;
export const taskDetailDtoSchema = taskSummaryDtoSchema.extend({ inputPreview: z.string().max(2_000).optional(), outputPreview: z.string().max(4_000).optional(), sharedState: z.record(z.string(), z.unknown()), localSummary: z.string().max(2_000).optional(), handoffs: z.array(z.object({ id: z.string(), senderAgentId: z.string(), receiverAgentId: z.string(), summary: z.string().max(1_000), artifactRefs: z.array(z.string().max(256)).max(50), memoryRefs: z.array(z.string().max(256)).max(50), createdAt: z.string().datetime() }).strict()).max(100), failure: z.object({ code: z.string().max(128), message: z.string().max(512) }).strict().optional() }).strict();
export type TaskDetailDto = z.infer<typeof taskDetailDtoSchema>;
export const taskPageDtoSchema = z.object({ items: z.array(taskSummaryDtoSchema).max(100), nextCursor: z.string().min(1).optional(), total: z.number().int().nonnegative() }).strict();
export type TaskPageDto = z.infer<typeof taskPageDtoSchema>;
export const taskGraphNodeDtoSchema = z.object({ id: z.string(), type: z.enum(["task", "agent", "result"]), label: z.string().max(180), status: z.string().max(64), role: z.string().max(128).optional(), agentId: z.string().max(256).optional(), taskId: z.string().max(256).optional(), position: z.object({ x: z.number(), y: z.number() }).strict() }).strict();
export type TaskGraphNodeDto = z.infer<typeof taskGraphNodeDtoSchema>;
export const taskGraphEdgeDtoSchema = z.object({ id: z.string(), source: z.string(), target: z.string(), kind: z.enum(["dependency", "delegation", "handoff", "review", "result"]) }).strict();
export type TaskGraphEdgeDto = z.infer<typeof taskGraphEdgeDtoSchema>;
export const taskGraphDtoSchema = z.object({ rootTaskId: z.string(), nodes: z.array(taskGraphNodeDtoSchema).max(500), edges: z.array(taskGraphEdgeDtoSchema).max(1_000), generatedAt: z.string().datetime() }).strict();
export type TaskGraphDto = z.infer<typeof taskGraphDtoSchema>;

export const metricPointDtoSchema = z.object({ at: z.string().datetime(), value: z.number().finite() }).strict();
export const runtimeMetricsDtoSchema = z.object({ generatedAt: z.string().datetime(), requestsTotal: z.number().int().nonnegative(), modelCalls: z.number().int().nonnegative(), providerFailures: z.number().int().nonnegative(), contextPressure: z.number().min(0).max(1), compactions: z.number().int().nonnegative(), memoryConsolidations: z.number().int().nonnegative(), retrievalLatencyMs: z.number().nonnegative().optional(), toolCalls: z.number().int().nonnegative(), ptcExecutions: z.number().int().nonnegative(), artifactSpills: z.number().int().nonnegative(), queueDepth: z.number().int().nonnegative(), activeWorkers: z.number().int().nonnegative(), sessions: z.number().int().nonnegative(), activeAgents: z.number().int().nonnegative(), activeTasks: z.number().int().nonnegative(), series: z.object({ requests: z.array(metricPointDtoSchema).max(60), pressure: z.array(metricPointDtoSchema).max(60), queue: z.array(metricPointDtoSchema).max(60) }).strict() }).strict();
export type RuntimeMetricsDto = z.infer<typeof runtimeMetricsDtoSchema>;
export const workerSummaryDtoSchema = z.object({ id: z.string(), status: z.enum(["idle", "running", "stopped", "draining"]), currentJobId: z.string().optional(), completedJobs: z.number().int().nonnegative(), failedJobs: z.number().int().nonnegative(), heartbeatAt: z.string().datetime() }).strict();
export type WorkerSummaryDto = z.infer<typeof workerSummaryDtoSchema>;
export const jobSummaryDtoSchema = z.object({ id: z.string(), type: z.string(), status: z.enum(["pending", "running", "completed", "failed"]), attempts: z.number().int().nonnegative(), availableAt: z.string().datetime(), leaseUntil: z.string().datetime().optional(), workerId: z.string().optional(), createdAt: z.string().datetime() }).strict();
export type JobSummaryDto = z.infer<typeof jobSummaryDtoSchema>;
export const operationsDtoSchema = z.object({ generatedAt: z.string().datetime(), health: healthDtoSchema, readiness: readinessDtoSchema, workers: z.array(workerSummaryDtoSchema).max(100), jobs: z.array(jobSummaryDtoSchema).max(100), storage: z.object({ databaseBytes: z.number().int().nonnegative().optional(), memoryCount: z.number().int().nonnegative(), artifactCount: z.number().int().nonnegative(), auditRows: z.number().int().nonnegative().optional() }).strict(), migrations: z.object({ schemaVersion: z.number().int().nonnegative(), pending: z.number().int().nonnegative() }).strict(), sandbox: z.object({ backend: z.string().max(128), status: z.enum(["available", "unavailable", "degraded"]), capabilities: z.array(z.string().max(64)).max(32) }).strict(), provider: z.object({ status: z.enum(["available", "degraded", "unavailable"]), names: z.array(z.string().max(128)).max(20) }).strict(), audit: z.object({ rows: z.number().int().nonnegative(), retention: z.string().max(128) }).strict() }).strict();
export type OperationsDto = z.infer<typeof operationsDtoSchema>;

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
