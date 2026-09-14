import {
  apiErrorResponseSchema,
  chatCancelResponseSchema,
  chatGenerationDtoSchema,
  chatMessagesDtoSchema,
  chatStreamEventDtoSchema,
  createSessionInputSchema,
  healthDtoSchema,
  metaDtoSchema,
  paginationQuerySchema,
  readinessDtoSchema,
  runtimeEventDtoSchema,
  runtimeSummaryDtoSchema,
  sessionDetailDtoSchema,
  sessionPageDtoSchema,
  type HealthDto,
  type ChatCancelResponse,
  type ChatGenerationDto,
  type ChatMessagesDto,
  type ChatStreamEventDto,
  type CreateSessionInput,
  type MetaDto,
  type ReadinessDto,
  type RuntimeEventDto,
  type RuntimeSummaryDto,
  type SessionDetailDto,
  type SessionPageDto,
  sessionSummaryDtoSchema,
  type SessionSummaryDto,
  contextInspectorDtoSchema,
  memoryInspectorQuerySchema,
  memoryPageDtoSchema,
  memoryDetailDtoSchema,
  memorySourceDtoSchema,
  historyMessageDtoSchema,
  retrievalInspectorDtoSchema,
  type ContextInspectorDto,
  type MemoryDetailDto,
  type MemoryInspectorQuery,
  type MemoryPageDto,
  type MemorySourceDto,
  type HistoryMessageDto,
  type RetrievalInspectorDto,
} from "@mnemos/contracts";

const baseUrl = (import.meta.env.VITE_MNEMOS_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";

export class ApiClientError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly requestId?: string) {
    super(message);
    this.name = "ApiClientError";
  }
}

export function apiUrl(path: string): string { return `${baseUrl}${path}`; }

export async function requestJson<T>(path: string, schema: { parse(value: unknown): T }, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(apiUrl(path), { ...init, headers: { accept: "application/json", ...(init?.headers ?? {}) } }); }
  catch { throw new ApiClientError("runtime_unavailable", "The Mnemos server is unavailable.", 503); }
  const requestId = response.headers.get("x-request-id") ?? undefined;
  let body: unknown;
  try { body = await response.json(); } catch { body = undefined; }
  if (!response.ok) {
    const parsed = apiErrorResponseSchema.safeParse(body);
    throw new ApiClientError(parsed.success ? parsed.data.error.code : "request_failed", parsed.success ? parsed.data.error.message : "The request failed.", response.status, parsed.success ? parsed.data.error.requestId ?? requestId : requestId);
  }
  try { return schema.parse(body); }
  catch { throw new ApiClientError("invalid_response", "The server returned an invalid response.", 502, requestId); }
}

export const api = {
  meta: (): Promise<MetaDto> => requestJson("/api/v1/meta", metaDtoSchema),
  health: (): Promise<HealthDto> => requestJson("/api/v1/health", healthDtoSchema),
  ready: (): Promise<ReadinessDto> => requestJson("/api/v1/ready", readinessDtoSchema),
  summary: (): Promise<RuntimeSummaryDto> => requestJson("/api/v1/runtime/summary", runtimeSummaryDtoSchema),
  sessions: (query: { limit?: number; cursor?: string } = {}): Promise<SessionPageDto> => {
    const parsed = paginationQuerySchema.parse({ ...query, ...(query.limit === undefined ? {} : { limit: Math.min(query.limit, 100) }) });
    const params = new URLSearchParams({ limit: String(parsed.limit), ...(parsed.cursor ? { cursor: parsed.cursor } : {}) });
    return requestJson(`/api/v1/sessions?${params.toString()}`, sessionPageDtoSchema);
  },
  session: (sessionId: string): Promise<SessionDetailDto> => requestJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, sessionDetailDtoSchema),
  createSession: (input: CreateSessionInput = {}): Promise<SessionSummaryDto> => requestJson("/api/v1/sessions", sessionSummaryDtoSchema, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(createSessionInputSchema.parse(input)) }),
  messages: (sessionId: string, query: { limit?: number; cursor?: string } = {}): Promise<ChatMessagesDto> => {
    const parsed = paginationQuerySchema.parse({ ...query, ...(query.limit === undefined ? {} : { limit: Math.min(query.limit, 100) }) });
    const params = new URLSearchParams({ limit: String(parsed.limit), ...(parsed.cursor ? { cursor: parsed.cursor } : {}) });
    return requestJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`, chatMessagesDtoSchema);
  },
  sendMessage: (sessionId: string, content: string): Promise<ChatGenerationDto> => requestJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, chatGenerationDtoSchema, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) }),
  retryMessage: (sessionId: string, messageId: string): Promise<ChatGenerationDto> => requestJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/retry`, chatGenerationDtoSchema, { method: "POST" }),
 cancelGeneration: (sessionId: string, generationId: string): Promise<ChatCancelResponse> => requestJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}/generations/${encodeURIComponent(generationId)}/cancel`, chatCancelResponseSchema, { method: "POST" }),
  context: (sessionId: string): Promise<ContextInspectorDto> => requestJson("/api/v1/sessions/" + encodeURIComponent(sessionId) + "/context", contextInspectorDtoSchema),
  memorySearch: (query: Partial<MemoryInspectorQuery> = {}): Promise<MemoryPageDto> => {
    const parsed = memoryInspectorQuerySchema.parse(query); const params = new URLSearchParams();
    for (const [key, value] of Object.entries(parsed)) if (value !== undefined && value !== "") params.set(key, String(value));
    return requestJson("/api/v1/memory?" + params.toString(), memoryPageDtoSchema);
  },
  memory: (memoryId: string): Promise<MemoryDetailDto> => requestJson("/api/v1/memory/" + encodeURIComponent(memoryId), memoryDetailDtoSchema),
  memorySources: (memoryId: string): Promise<MemorySourceDto[]> => requestJson("/api/v1/memory/" + encodeURIComponent(memoryId) + "/sources", memorySourceDtoSchema.array()),
  historyMessage: (sessionId: string, messageId: string): Promise<HistoryMessageDto> => requestJson("/api/v1/sessions/" + encodeURIComponent(sessionId) + "/history/" + encodeURIComponent(messageId), historyMessageDtoSchema),
  retrieval: (sessionId: string, messageId: string): Promise<RetrievalInspectorDto> => requestJson("/api/v1/sessions/" + encodeURIComponent(sessionId) + "/messages/" + encodeURIComponent(messageId) + "/retrieval", retrievalInspectorDtoSchema),
};

export function subscribeToChatStream(sessionId: string, generationId: string, onEvent: (event: ChatStreamEventDto) => void, onStatus?: (status: "live" | "closed" | "error") => void): () => void {
  const source = new EventSource(apiUrl(`/api/v1/sessions/${encodeURIComponent(sessionId)}/generations/${encodeURIComponent(generationId)}/events`));
  const eventTypes = ["started", "text_delta", "activity", "completed", "cancelled", "failed"] as const;
  const handle = (message: MessageEvent<string>): void => { try { const parsed = chatStreamEventDtoSchema.safeParse(JSON.parse(message.data)); if (parsed.success) { onStatus?.("live"); onEvent(parsed.data); } } catch { onStatus?.("error"); } };
  for (const type of eventTypes) source.addEventListener(`chat.${type}`, handle);
  source.onopen = () => onStatus?.("live");
  source.onerror = () => onStatus?.(source.readyState === EventSource.CLOSED ? "error" : "closed");
  return () => { for (const type of eventTypes) source.removeEventListener(`chat.${type}`, handle); source.close(); };
}

export function subscribeToEvents(onEvent: (event: RuntimeEventDto) => void, onStatus: (status: "live" | "reconnecting" | "disconnected") => void): () => void {
  const source = new EventSource(apiUrl("/api/v1/events"));
  const eventTypes = ["runtime.ready", "runtime.started", "runtime.stopped", "message.received", "message.generated", "context.pressure.changed", "context.compaction.requested", "context.evicted", "memory.created", "memory.updated", "memory.superseded", "tool.called", "tool.completed", "tool.failed", "ptc.started", "ptc.completed", "ptc.failed", "agent.started", "agent.completed", "agent.failed", "task.created", "task.started", "task.completed", "task.failed", "task.cancelled", "agent.handoff"] as const;
  const handle = (message: MessageEvent<string>): void => {
    try {
      const parsed = runtimeEventDtoSchema.safeParse(JSON.parse(message.data));
      if (parsed.success) { onStatus("live"); onEvent(parsed.data); }
    } catch { /* malformed realtime payloads are ignored at the UI boundary */ }
  };
  for (const type of eventTypes) source.addEventListener(type, handle);
  source.onopen = () => onStatus("live");
  source.onerror = () => onStatus(source.readyState === EventSource.CONNECTING ? "reconnecting" : "disconnected");
  return () => { for (const type of eventTypes) source.removeEventListener(type, handle); source.close(); };
}
