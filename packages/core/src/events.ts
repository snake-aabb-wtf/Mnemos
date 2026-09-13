import type { ContextStats } from "./context.js";
import type { ContextEviction } from "./compaction.js";
import type { ConsolidationJob, ConsolidationResult } from "./consolidation.js";
import type { HistoryMessage } from "./contracts.js";
import type { MemoryRecord } from "./memory.js";
import type { ArtifactHandle } from "./artifact.js";
import type { ToolExecutionError } from "./tool.js";

export interface HarnessEventMap {
  "message.received": { message: HistoryMessage };
  "message.generated": { message: HistoryMessage };
  "context.pressure": { sessionId: string; stats: ContextStats };
  "context.compaction.requested": {
    sessionId: string;
    stats: ContextStats;
    reason: "high" | "emergency";
  };
  /** Emitted only after an automatic pin and durable compaction checkpoint are updated. */
  "context.evicted": ContextEviction;
  "memory.consolidation.requested": { job: ConsolidationJob; created: boolean };
  "memory.consolidation.started": { job: ConsolidationJob };
  "memory.consolidation.completed": ConsolidationResult;
  "memory.consolidation.failed": { job: ConsolidationJob; error: string };
  "memory.created": { jobId: string; memory: MemoryRecord };
  "memory.updated": { jobId: string; memory: MemoryRecord };
  "memory.superseded": { jobId: string; superseded: MemoryRecord; replacement: MemoryRecord };
  /** Tool events intentionally carry identifiers and sizes, never raw arguments or outputs. */
  "tool.called": { callId: string; toolName: string; sessionId: string; agentId: string; status: "called" };
  "tool.completed": {
    callId: string;
    toolName: string;
    sessionId: string;
    agentId: string;
    durationMs: number;
    status: "success";
    outputKind: "inline" | "artifact";
  };
  "tool.failed": {
    callId: string;
    toolName: string;
    sessionId: string;
    agentId: string;
    durationMs: number;
    status: "error";
    errorCode: ToolExecutionError["code"];
  };
  "tool.denied": {
    callId: string;
    toolName: string;
    sessionId: string;
    agentId: string;
    durationMs: number;
    status: "denied";
    errorCode: "permission_denied";
  };
  "tool.output.spilled": {
    callId: string;
    toolName: string;
    sessionId: string;
    agentId: string;
    durationMs: number;
    status: "success";
    handle: ArtifactHandle;
    serializedBytes: number;
  };
  /** PTC events contain execution metadata only; program source and intermediate values stay out of events. */
  "ptc.started": { executionId: string; sessionId: string; agentId: string };
  "ptc.completed": {
    executionId: string;
    sessionId: string;
    agentId: string;
    durationMs: number;
    toolCallCount: number;
    peakConcurrency: number;
    status: "success";
  };
  "ptc.failed": {
    executionId: string;
    sessionId: string;
    agentId: string;
    durationMs: number;
    toolCallCount: number;
    status: "error";
    errorCode: string;
  };
  "tool.discovery.searched": {
    sessionId: string;
    agentId: string;
    query: string;
    candidateCount: number;
    durationMs: number;
  };
  "tool.discovery.described": {
    sessionId: string;
    agentId: string;
    names: readonly string[];
    loadedNames: readonly string[];
    schemaTokenEstimate: number;
    durationMs: number;
  };
  "tool.loaded": { sessionId: string; agentId: string; toolNames: readonly string[]; schemaTokenEstimate: number };
  "tool.unloaded": { sessionId: string; agentId: string; toolNames: readonly string[]; reason: "lru" | "budget" | "registry" };
}

type Listener<T> = (payload: T) => void | Promise<void>;

/** A process-local event bus. Persistent event delivery is deliberately deferred past Phase 1. */
export class EventBus<Events extends object = HarnessEventMap> {
  private readonly listeners = new Map<keyof Events, Set<Listener<Events[keyof Events]>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const current = this.listeners.get(event) ?? new Set();
    current.add(listener as Listener<Events[keyof Events]>);
    this.listeners.set(event, current);
    return () => current.delete(listener as Listener<Events[keyof Events]>);
  }

  async emit<K extends keyof Events>(event: K, payload: Events[K]): Promise<void> {
    const listeners = this.listeners.get(event);
    if (!listeners) return;
    for (const listener of listeners) await listener(payload);
  }
}
