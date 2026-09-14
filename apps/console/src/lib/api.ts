import {
  apiErrorResponseSchema,
  healthDtoSchema,
  metaDtoSchema,
  paginationQuerySchema,
  readinessDtoSchema,
  runtimeEventDtoSchema,
  runtimeSummaryDtoSchema,
  sessionDetailDtoSchema,
  sessionPageDtoSchema,
  type HealthDto,
  type MetaDto,
  type ReadinessDto,
  type RuntimeEventDto,
  type RuntimeSummaryDto,
  type SessionDetailDto,
  type SessionPageDto,
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
    const parsed = paginationQuerySchema.parse(query);
    const params = new URLSearchParams({ limit: String(parsed.limit), ...(parsed.cursor ? { cursor: parsed.cursor } : {}) });
    return requestJson(`/api/v1/sessions?${params.toString()}`, sessionPageDtoSchema);
  },
  session: (sessionId: string): Promise<SessionDetailDto> => requestJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, sessionDetailDtoSchema),
};

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
