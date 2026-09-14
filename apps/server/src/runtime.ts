import { randomUUID } from "node:crypto";
import {
  EventBus,
  RuntimeHealthService,
  type HarnessEventMap,
} from "@mnemos/core";
import {
  metaDtoSchema,
  runtimeSummaryDtoSchema,
  sessionDetailDtoSchema,
  sessionPageDtoSchema,
  sessionSummaryDtoSchema,
  type MetaDto,
  type RuntimeSummaryDto,
  type SessionDetailDto,
  type SessionPageDto,
  type SessionSummaryDto,
} from "@mnemos/contracts";

export interface SessionQuery {
  limit: number;
  cursor?: string;
}

export interface ConsoleRuntimeService {
  readonly health: RuntimeHealthService;
  readonly events: EventBus<HarnessEventMap>;
  meta(): Promise<MetaDto>;
  summary(): Promise<RuntimeSummaryDto>;
  listSessions(query: SessionQuery): Promise<SessionPageDto>;
  getSession(sessionId: string): Promise<SessionDetailDto | undefined>;
  createDemoSession?(): Promise<SessionSummaryDto>;
}

interface DemoSession {
  summary: SessionSummaryDto;
  recentMessages: SessionDetailDto["recentMessages"];
}

/**
 * A deterministic, in-memory runtime adapter for local Console development.
 * Production composition should provide a service backed by the real Harness
 * and storage repositories instead of using this demo implementation.
 */
export class DemoConsoleRuntimeService implements ConsoleRuntimeService {
  readonly events = new EventBus<HarnessEventMap>();
  readonly health: RuntimeHealthService;
  private readonly startedAt = Date.now();
  private readonly sessions = new Map<string, DemoSession>();

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

  async meta(): Promise<MetaDto> {
    return metaDtoSchema.parse({ version: "0.1.0", apiVersion: "v1", schemaVersion: 1, serverTime: new Date().toISOString() });
  }

  async summary(): Promise<RuntimeSummaryDto> {
    const activeSessions = [...this.sessions.values()].filter((session) => session.summary.status === "active").length;
    return runtimeSummaryDtoSchema.parse({
      status: "ready",
      version: "0.1.0",
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      sessionsCount: this.sessions.size,
      activeSessions,
      registeredAgents: 6,
      activeAgents: 0,
      queuedJobs: 0,
      runningPtcExecutions: 0,
      memoryCount: 0,
      artifactCount: 0,
      contextLimitTokens: 131_072,
      sandboxBackend: "demo",
      sandboxStatus: "available",
      profile: this.profile,
    });
  }

  async listSessions(query: SessionQuery): Promise<SessionPageDto> {
    const sessions = [...this.sessions.values()].map((entry) => entry.summary);
    const offset = decodeCursor(query.cursor);
    const items = sessions.slice(offset, offset + query.limit);
    const nextOffset = offset + items.length;
    return sessionPageDtoSchema.parse({ items, ...(nextOffset < sessions.length ? { nextCursor: encodeCursor(nextOffset) } : {}) });
  }

  async getSession(sessionId: string): Promise<SessionDetailDto | undefined> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return undefined;
    return sessionDetailDtoSchema.parse({
      ...session.summary,
      recentMessages: session.recentMessages,
      activeAgentIds: [],
      taskSummary: { pending: 0, running: 0, completed: 0, failed: 0 },
    });
  }

  async createDemoSession(): Promise<SessionSummaryDto> {
    const id = `demo-${randomUUID().slice(0, 8)}`;
    const session = this.seed(id, "New demo session");
    await this.emitDemoEvent();
    return session;
  }

  async emitDemoEvent(): Promise<void> {
    await this.events.emit("runtime.ready", { runtimeVersion: "0.1.0", schemaVersion: 1 });
  }

  private seed(id: string, displayName: string): SessionSummaryDto {
    const createdAt = new Date(this.startedAt).toISOString();
    const updatedAt = new Date().toISOString();
    const summary = sessionSummaryDtoSchema.parse({ id, createdAt, updatedAt, status: "active", messageCount: 2, agentCount: 1, displayName });
    this.sessions.set(id, {
      summary,
      recentMessages: [
        { id: `${id}-m1`, role: "user", preview: "Inspect the runtime foundation.", createdAt },
        { id: `${id}-m2`, role: "assistant", preview: "The runtime is ready for observation.", createdAt: updatedAt },
      ],
    });
    return summary;
  }
}

function encodeCursor(offset: number): string { return Buffer.from(String(offset), "utf8").toString("base64url"); }
function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isInteger(value) && value >= 0 ? value : -1;
}
