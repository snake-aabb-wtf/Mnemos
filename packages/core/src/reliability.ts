import { createHash } from "node:crypto";
import type { HistoryMessage, HistoryStore } from "./contracts.js";
import type { BuiltContext } from "./context.js";
import type { MemoryService, MemoryRecord } from "./memory.js";
import type { ArtifactRecord } from "./artifact.js";

/** A reproducible PRNG for reliability workloads. It is deliberately tiny and dependency-free. */
export class SeededRandom {
  private state: number;

  constructor(seed: number | string) {
    const text = String(seed);
    this.state = Number.parseInt(createHash("sha256").update(text).digest("hex").slice(0, 8), 16) || 0x9e3779b9;
  }

  next(): number {
    let value = this.state | 0;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value | 0;
    return (this.state >>> 0) / 0x1_0000_0000;
  }

  int(min: number, maxInclusive: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(maxInclusive) || maxInclusive < min) throw new Error("Invalid seeded random range");
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }

  pick<T>(values: readonly T[]): T {
    if (values.length === 0) throw new Error("Cannot pick from an empty array");
    return values[this.int(0, values.length - 1)]!;
  }
}

export interface SyntheticFactInjection {
  turn: number;
  key: string;
  value: string;
  content?: string;
}

export interface SyntheticConversationOptions {
  seed: number | string;
  sessionId?: string;
  startAt?: string;
  turnSpacingMs?: number;
  facts?: readonly SyntheticFactInjection[];
  needleTurns?: readonly number[];
}

export interface SyntheticConversationWorkload {
  seed: string;
  sessionId: string;
  messages: readonly HistoryMessage[];
  facts: readonly SyntheticFactInjection[];
  needles: readonly string[];
}

/** Generates compact, structured History messages instead of slow natural-language filler. */
export class SyntheticConversationGenerator {
  private readonly options: Required<Pick<SyntheticConversationOptions, "sessionId" | "startAt" | "turnSpacingMs">> & SyntheticConversationOptions;

  constructor(options: SyntheticConversationOptions) {
    this.options = {
      ...options,
      sessionId: options.sessionId ?? "synthetic-session",
      startAt: options.startAt ?? "2026-01-01T00:00:00.000Z",
      turnSpacingMs: options.turnSpacingMs ?? 60_000,
    };
  }

  generate(turns: number): SyntheticConversationWorkload {
    if (!Number.isInteger(turns) || turns < 0 || turns > 1_000_000) throw new Error("Synthetic turns must be between 0 and 1,000,000");
    const facts = [...(this.options.facts ?? [])].sort((left, right) => left.turn - right.turn || left.key.localeCompare(right.key));
    const needles = new Set(this.options.needleTurns ?? []);
    const messages: HistoryMessage[] = [];
    const start = new Date(this.options.startAt).getTime();
    const factsByTurn = new Map<number, SyntheticFactInjection[]>();
    for (const fact of facts) factsByTurn.set(fact.turn, [...(factsByTurn.get(fact.turn) ?? []), fact]);
    for (let turn = 1; turn <= turns; turn += 1) {
      const timestamp = new Date(start + (turn - 1) * this.options.turnSpacingMs).toISOString();
      const turnId = `turn-${turn}`;
      const injected = factsByTurn.get(turn) ?? [];
      const needle = needles.has(turn) ? ` needle=${stableId(this.options.seed, "needle", turn)}` : "";
      const factText = injected.map((fact) => ` fact.${fact.key}=${fact.value}`).join("");
      messages.push({
        id: stableUuid(this.options.seed, "user", turn),
        sessionId: this.options.sessionId,
        role: "user",
        content: `synthetic turn=${turn}${needle}${factText}`,
        createdAt: timestamp,
        metadata: { taskId: `task-${Math.floor((turn - 1) / 100)}`, turnId },
      });
      messages.push({
        id: stableUuid(this.options.seed, "assistant", turn),
        sessionId: this.options.sessionId,
        role: "assistant",
        content: injected.length > 0 ? `ack turn=${turn}; recorded ${injected.map((fact) => fact.key).join(",")}` : `ack turn=${turn}`,
        createdAt: new Date(start + (turn - 1) * this.options.turnSpacingMs + 1).toISOString(),
        metadata: { taskId: `task-${Math.floor((turn - 1) / 100)}`, turnId },
      });
    }
    return { seed: String(this.options.seed), sessionId: this.options.sessionId, messages, facts, needles: [...needles].sort((a, b) => a - b).map((turn) => stableId(this.options.seed, "needle", turn)) };
  }
}

export interface FaultInjection {
  operation: string;
  failAt: number;
  mode?: "throw" | "timeout" | "malformed";
  message?: string;
}

/** Deterministic, explicit fault schedule used by recovery tests. */
export class FaultInjectionController {
  private readonly counts = new Map<string, number>();
  private readonly schedules = new Map<string, FaultInjection>();

  arm(injection: FaultInjection): void {
    if (!Number.isInteger(injection.failAt) || injection.failAt < 1) throw new Error("failAt must be a positive integer");
    this.schedules.set(injection.operation, { ...injection });
  }

  clear(operation?: string): void {
    if (operation === undefined) {
      this.schedules.clear();
      this.counts.clear();
    } else {
      this.schedules.delete(operation);
      this.counts.delete(operation);
    }
  }

  count(operation: string): number { return this.counts.get(operation) ?? 0; }

  hit(operation: string): FaultInjection | undefined {
    const count = (this.counts.get(operation) ?? 0) + 1;
    this.counts.set(operation, count);
    const schedule = this.schedules.get(operation);
    if (schedule === undefined || count !== schedule.failAt) return undefined;
    if (schedule.mode === "throw" || schedule.mode === undefined) throw new ReliabilityInjectedFailure(schedule.message ?? `Injected failure at ${operation}#${count}`);
    return schedule;
  }

  async run<T>(operation: string, action: () => Promise<T>): Promise<T> {
    const injection = this.hit(operation);
    if (injection?.mode === "timeout") await new Promise<void>((resolve) => setTimeout(resolve, 25));
    if (injection?.mode === "malformed") return undefined as T;
    return action();
  }
}

export class ReliabilityInjectedFailure extends Error {
  readonly code = "reliability_injected_failure";

  constructor(message: string) {
    super(message);
    this.name = "ReliabilityInjectedFailure";
  }
}

export interface ReliabilityInvariantContext {
  sessionId?: string;
  history?: HistoryStore;
  memories?: MemoryService;
  contexts?: readonly BuiltContext[];
  records?: readonly MemoryRecord[];
  artifactRecords?: readonly Pick<ArtifactRecord, "id" | "storageLocation">[];
  toolCallIds?: readonly string[];
}

export interface ReliabilityInvariant {
  readonly name: string;
  check(context: ReliabilityInvariantContext): Promise<void> | void;
}

export class ReliabilityInvariantViolation extends Error {
  constructor(readonly invariant: string, message: string) {
    super(`${invariant}: ${message}`);
    this.name = "ReliabilityInvariantViolation";
  }
}

export const reliabilityInvariants: readonly ReliabilityInvariant[] = [
  {
    name: "context.safe-for-model",
    check(context) {
      for (const built of context.contexts ?? []) {
        if (built.stats.usedTokens + built.stats.generationReserveTokens > built.stats.contextLimit) {
          throw new ReliabilityInvariantViolation("context.safe-for-model", "visible request exceeds configured context limit");
        }
      }
    },
  },
  {
    name: "memory.source-references",
    async check(context) {
      if (!context.memories) return;
      for (const memory of context.records ?? await context.memories.list({ statuses: ["active", "provisional", "superseded", "archived"], limit: 20_000 })) {
        if (memory.sourceReferences.length === 0) throw new ReliabilityInvariantViolation("memory.source-references", `${memory.id} has no provenance`);
        await context.memories.source(memory.id);
        if (memory.status === "superseded" && memory.supersededBy === undefined) throw new ReliabilityInvariantViolation("memory.source-references", `${memory.id} has no successor`);
      }
    },
  },
  {
    name: "history.unique-ids",
    async check(context) {
      if (!context.history || !context.sessionId) return;
      const messages = await context.history.list(context.sessionId);
      if (new Set(messages.map((message) => message.id)).size !== messages.length) throw new ReliabilityInvariantViolation("history.unique-ids", "duplicate message ID");
    },
  },
  {
    name: "memory.lifecycle-links",
    check(context) {
      const records = context.records ?? [];
      const ids = new Set(records.map((record) => record.id));
      for (const record of records) {
        if (record.supersededBy !== undefined && !ids.has(record.supersededBy)) {
          throw new ReliabilityInvariantViolation("memory.lifecycle-links", `${record.id} points to missing supersededBy ${record.supersededBy}`);
        }
        for (const source of record.derivedFromMemoryIds) if (!ids.has(source)) {
          throw new ReliabilityInvariantViolation("memory.lifecycle-links", `${record.id} points to missing derived memory ${source}`);
        }
      }
    },
  },
  {
    name: "artifact.safe-handles",
    check(context) {
      const ids = new Set<string>();
      for (const artifact of context.artifactRecords ?? []) {
        if (ids.has(artifact.id)) throw new ReliabilityInvariantViolation("artifact.safe-handles", `duplicate artifact ${artifact.id}`);
        ids.add(artifact.id);
        if (artifact.storageLocation.includes("..") || artifact.storageLocation.includes("\\") || artifact.storageLocation.startsWith("/")) {
          throw new ReliabilityInvariantViolation("artifact.safe-handles", `unsafe storage location for ${artifact.id}`);
        }
      }
    },
  },
  {
    name: "tools.unique-call-ids",
    check(context) {
      const ids = context.toolCallIds ?? [];
      if (new Set(ids).size !== ids.length) throw new ReliabilityInvariantViolation("tools.unique-call-ids", "duplicate tool call ID");
    },
  },
];

export async function assertReliabilityInvariants(context: ReliabilityInvariantContext, invariants: readonly ReliabilityInvariant[] = reliabilityInvariants): Promise<void> {
  for (const invariant of invariants) await invariant.check(context);
}

export interface NormalizedRuntimeSnapshot {
  history: readonly { sessionId: string; role: HistoryMessage["role"]; content: string; metadata?: Record<string, unknown> }[];
  memories: readonly { type: MemoryRecord["type"]; content: string; status: MemoryRecord["status"]; confidence: number; sourceIds: readonly string[]; derivedFromMemoryIds: readonly string[]; scope: MemoryRecord["scope"] }[];
}

/** Compares logical state while intentionally ignoring UUIDs and timestamps. */
export async function normalizedRuntimeSnapshot(history: HistoryStore, memories: MemoryService, sessionId: string): Promise<NormalizedRuntimeSnapshot> {
  const messages = await history.list(sessionId);
  const records = await memories.list({ statuses: ["active", "provisional", "superseded", "archived"], limit: 20_000 });
  return {
    history: messages.map(({ sessionId: messageSession, role, content, metadata }) => ({ sessionId: messageSession, role, content, ...(metadata === undefined ? {} : { metadata }) })),
    memories: records.map((record) => ({ type: record.type, content: record.content, status: record.status, confidence: record.confidence, sourceIds: [...record.sourceIds].sort(), derivedFromMemoryIds: [...record.derivedFromMemoryIds].sort(), scope: record.scope })),
  };
}

export interface ReliabilityMetrics {
  turns: number;
  compactions: number;
  toolCalls: number;
  ptcExecutions: number;
  memoryCount: number;
  activeMemoryCount: number;
  supersededMemoryCount: number;
  artifactCount: number;
  peakContextTokens: number;
  retrievalRecallAtK?: number;
  sourceTracingAccuracy?: number;
}

export interface PerformanceSample { name: string; durationMs: number; units: number; }

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(p * ordered.length) - 1))]!;
}

export function stableId(seed: number | string, kind: string, value: number | string): string {
  return createHash("sha256").update(`${String(seed)}:${kind}:${String(value)}`).digest("hex").slice(0, 16);
}

function stableUuid(seed: number | string, kind: string, value: number): string {
  const hex = createHash("sha256").update(`${String(seed)}:${kind}:${String(value)}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}
