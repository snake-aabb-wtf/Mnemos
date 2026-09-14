import { z } from "zod";
import type { ArtifactHandle } from "./artifact.js";
import type { HistoryMessage } from "./contracts.js";
import { ContextPolicyEngine, type ContextPolicyDecision, type ContextPolicyRuntimeState, type ContextPolicySnapshot, type ContextPressureLevel } from "./context-policy.js";
import type { EventBus, HarnessEventMap } from "./events.js";

export interface TokenEstimator {
  estimateText(text: string): number;
  estimateMessage(message: HistoryMessage): number;
}

/** Deliberately conservative fallback. A provider-specific tokenizer can replace this later. */
export class CharacterTokenEstimator implements TokenEstimator {
  estimateText(text: string): number {
    return text.length === 0 ? 0 : Math.ceil(text.length / 4);
  }

  estimateMessage(message: HistoryMessage): number {
    return this.estimateText(message.content) + 4;
  }
}

export interface ContextBudgets {
  contextLimit: number;
  reservedTokens: number;
  /** Canonical name for the mandatory output reserve; reservedTokens remains a compatibility alias. */
  generationReserveTokens: number;
  recentRawTokenBudget: number;
  pinnedTokenBudget: number;
  agentPinnedTokenBudget: number;
  retrievedMemoryTokenBudget: number;
  toolSchemaTokenBudget: number;
  toolResultTokenBudget: number;
  softPressureThreshold: number;
  elevatedPressureThreshold: number;
  highPressureThreshold: number;
  compactionPressureThreshold: number;
  emergencyPressureThreshold: number;
  pressureHysteresis: number;
}

export const defaultContextBudgets: ContextBudgets = {
  contextLimit: 128_000,
  reservedTokens: 20_000,
  generationReserveTokens: 20_000,
  recentRawTokenBudget: 48_000,
  pinnedTokenBudget: 16_000,
  agentPinnedTokenBudget: 8_000,
  retrievedMemoryTokenBudget: 8_000,
  toolSchemaTokenBudget: 8_000,
  toolResultTokenBudget: 16_000,
  softPressureThreshold: 0.6,
  elevatedPressureThreshold: 0.6,
  highPressureThreshold: 0.75,
  compactionPressureThreshold: 0.85,
  emergencyPressureThreshold: 0.92,
  pressureHysteresis: 0.02,
};

export const pinnedContextSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  source: z.enum(["system", "automatic", "visible-agent"]),
  priority: z.enum(["critical", "normal", "low"]).optional(),
  createdAt: z.string().datetime().optional(),
  expiresAtTurn: z.number().int().positive().optional(),
  /** Undefined pins apply to every session; automatic pins are always session-scoped. */
  sessionId: z.string().min(1).optional(),
  /** Inclusive canonical-history range represented by an automatic pin. */
  sourceRange: z.object({
    firstMessageId: z.string().uuid(),
    lastMessageId: z.string().uuid(),
    messageCount: z.number().int().positive(),
  }).optional(),
});
export type PinnedContext = z.infer<typeof pinnedContextSchema>;

export interface ContextStats {
  usedTokens: number;
  contextLimit: number;
  availableTokens: number;
  safeHeadroomTokens: number;
  systemTokens: number;
  pinnedTokens: number;
  recentRawTokens: number;
  /** Artifact handles are context-safe references; their backing bodies are excluded. */
  artifactHandleTokens: number;
  /** Native tool declarations offered to the model in this context. */
  toolSchemaTokens: number;
  retrievedMemoryTokens: number;
  toolResultTokens: number;
  reservedTokens: number;
  generationReserveTokens: number;
  pressure: number;
  pressureLevel: ContextPressureLevel;
}

export interface BuiltContext {
  pinned: readonly PinnedContext[];
  recentMessages: readonly HistoryMessage[];
  artifactHandles: readonly ArtifactHandle[];
  /** Compact rendered native-tool declarations; Phase 9 can selectively reduce this list. */
  toolSchemas: readonly string[];
  stats: ContextStats;
}

/** A bounded, inspectable description of an Artifact; never include its body. */
export function artifactHandleContextText(handle: ArtifactHandle): string {
  return [
    `Artifact: ${handle.id}`,
    `Type: ${handle.type}`,
    ...(handle.mimeType === undefined ? [] : [`MIME: ${handle.mimeType}`]),
    `Size: ${handle.sizeBytes} bytes`,
    ...(handle.summary === undefined ? [] : [`Summary: ${handle.summary}`]),
  ].join("\n");
}

export class ContextManager {
  private readonly pins = new Map<string, PinnedContext>();
  private readonly turnCounters = new Map<string, number>();
  private readonly compactionRequests = new Set<string>();
  private readonly sessionToolSchemas = new Map<string, readonly string[]>();
  private readonly sessionSystemPrompts = new Map<string, string>();
  private readonly snapshots = new Map<string, ContextPolicySnapshot>();
  readonly policyEngine: ContextPolicyEngine;
  readonly budgets: ContextBudgets;

  constructor(
    private readonly tokenEstimator: TokenEstimator = new CharacterTokenEstimator(),
    budgets: Partial<ContextBudgets> = {},
    private events?: EventBus<HarnessEventMap>,
  ) {
    const reserve = budgets.generationReserveTokens ?? budgets.reservedTokens ?? defaultContextBudgets.generationReserveTokens;
    this.budgets = { ...defaultContextBudgets, ...budgets, reservedTokens: reserve, generationReserveTokens: reserve,
      elevatedPressureThreshold: budgets.elevatedPressureThreshold ?? budgets.softPressureThreshold ?? defaultContextBudgets.elevatedPressureThreshold,
      compactionPressureThreshold: budgets.compactionPressureThreshold ?? budgets.highPressureThreshold ?? defaultContextBudgets.compactionPressureThreshold };
    this.policyEngine = new ContextPolicyEngine();
    this.validateBudgets();
  }

  addPin(pin: PinnedContext): void {
    const normalized = this.normalizePin(pin);
    if (normalized.source === "visible-agent" && this.hasDuplicateAgentPin(normalized)) return;
    const next = new Map(this.pins);
    next.set(this.pinKey(normalized), normalized);
    if (this.pinTokens(this.applicablePins(next.values(), normalized.sessionId)) > this.budgets.pinnedTokenBudget) {
      throw new Error("Pinned context would exceed its token budget");
    }
    if (normalized.source === "visible-agent" && this.pinTokens([...next.values()].filter((candidate) => candidate.source === "visible-agent" && candidate.sessionId === normalized.sessionId)) > this.budgets.agentPinnedTokenBudget) {
      throw new Error("Agent pinned context would exceed its token budget");
    }
    this.pins.set(this.pinKey(normalized), normalized);
    void this.events?.emit("context.pin.created", { sessionId: normalized.sessionId, pinId: normalized.id, source: normalized.source, tokenEstimate: this.tokenEstimator.estimateText(normalized.content) }).catch(() => undefined);
  }

  /** Replaces a pin atomically with respect to the configured token budget. */
  upsertPin(pin: PinnedContext): PinnedContext | undefined {
    const previous = this.pins.get(this.pinKey(pin));
    this.addPin(pin);
    return previous;
  }

  removePin(id: string, sessionId?: string): boolean {
    return this.pins.delete(this.pinKey({ id, sessionId }));
  }

  removeAgentPin(id: string, sessionId: string): boolean {
    const pin = this.pins.get(this.pinKey({ id, sessionId }));
    if (pin === undefined || pin.source !== "visible-agent") return false;
    this.pins.delete(this.pinKey({ id, sessionId }));
    void this.events?.emit("context.pin.removed", { sessionId, pinId: id, source: pin.source, reason: "explicit" }).catch(() => undefined);
    return true;
  }

  listPins(sessionId?: string): readonly PinnedContext[] {
    if (sessionId !== undefined) this.expirePins(sessionId);
    return [...this.applicablePins(this.pins.values(), sessionId)];
  }

  advanceTurn(sessionId: string): number {
    const turn = (this.turnCounters.get(sessionId) ?? 0) + 1;
    this.turnCounters.set(sessionId, turn);
    this.expirePins(sessionId);
    return turn;
  }

  currentTurn(sessionId: string): number { return this.turnCounters.get(sessionId) ?? 0; }

  requestCompaction(sessionId: string): void { this.compactionRequests.add(sessionId); }
  consumeCompactionRequest(sessionId: string): boolean { const requested = this.compactionRequests.delete(sessionId); return requested; }
  setSessionToolSchemas(sessionId: string, schemas: readonly string[]): void { this.sessionToolSchemas.set(sessionId, [...schemas]); }
  getSessionToolSchemas(sessionId: string): readonly string[] { return this.sessionToolSchemas.get(sessionId) ?? []; }
  setSessionSystemPrompt(sessionId: string, prompt: string): void { this.sessionSystemPrompts.set(sessionId, prompt); }
  getSessionSystemPrompt(sessionId: string): string { return this.sessionSystemPrompts.get(sessionId) ?? ""; }

  getTokenEstimator(): TokenEstimator {
    return this.tokenEstimator;
  }

  attachEvents(events: EventBus<HarnessEventMap>): void { this.events = events; }

  policyDecision(sessionId: string, stats: ContextStats, state?: ContextPolicyRuntimeState): ContextPolicyDecision {
    const decision = this.policyEngine.evaluate(stats, this.budgets, sessionId, state);
    this.snapshots.set(sessionId, { sessionId, stats, decision, capturedAt: new Date().toISOString() });
    return decision;
  }

  policySnapshot(sessionId: string): ContextPolicySnapshot | undefined { return this.snapshots.get(sessionId); }

  isSafeForModel(context: BuiltContext): boolean {
    return context.stats.usedTokens + context.stats.generationReserveTokens <= context.stats.contextLimit;
  }

  effectiveRetrievalTokenBudget(sessionId: string, stats?: ContextStats): number {
    const current = stats ?? this.build([], "", sessionId).stats;
    return this.policyDecision(sessionId, current).effectiveRetrievalTokenBudget;
  }

  packWithinTokenBudget<T>(items: readonly T[], budgetTokens: number): { items: readonly T[]; includedTokens: number; droppedCount: number } {
    const selected: T[] = [];
    let includedTokens = 0;
    for (const item of items) {
      const tokens = this.tokenEstimator.estimateText(JSON.stringify(item));
      if (tokens > budgetTokens || includedTokens + tokens > budgetTokens) break;
      selected.push(item);
      includedTokens += tokens;
    }
    return { items: selected, includedTokens, droppedCount: items.length - selected.length };
  }

  /** Remaining pin budget for one session, optionally excluding a pin being replaced. */
  availablePinTokens(sessionId: string, excludingPinId?: string): number {
    const used = this.pinTokens(this.listPins(sessionId).filter((pin) => pin.id !== excludingPinId));
    return Math.max(0, this.budgets.pinnedTokenBudget - used);
  }

  /** Phase 1 compatibility helper: selects recent messages from complete history. */
  build(history: readonly HistoryMessage[], systemPrompt = "", sessionId = history[0]?.sessionId): BuiltContext {
    const recentMessages = this.selectRecent(history);
    return this.buildVisible(sessionId, recentMessages, systemPrompt);
  }

  /** Builds a context from an already selected visible working set. */
  buildVisible(
    sessionId: string | undefined,
    recentMessages: readonly HistoryMessage[],
    systemPrompt = "",
    artifactHandles: readonly ArtifactHandle[] = [],
    toolSchemas: readonly string[] = [],
  ): BuiltContext {
    const pins = this.listPins(sessionId);
    const systemTokens = this.tokenEstimator.estimateText(systemPrompt);
    const pinnedTokens = this.pinTokens(pins);
    const recentRawTokens = recentMessages
      .filter((message) => message.role !== "tool")
      .reduce((sum, message) => sum + this.tokenEstimator.estimateMessage(message), 0);
    const toolResultTokens = recentMessages
      .filter((message) => message.role === "tool")
      .reduce((sum, message) => sum + this.tokenEstimator.estimateMessage(message), 0);
    const artifactHandleTokens = artifactHandles.reduce(
      (sum, handle) => sum + this.tokenEstimator.estimateText(artifactHandleContextText(handle)),
      0,
    );
    const toolSchemaTokens = toolSchemas.reduce((sum, schema) => sum + this.tokenEstimator.estimateText(schema), 0);
    const retrievedMemoryTokens = recentMessages
      .filter((message) => message.role === "tool" && typeof message.metadata?.toolName === "string" && (message.metadata.toolName as string).startsWith("memory."))
      .reduce((sum, message) => sum + this.tokenEstimator.estimateMessage(message), 0);
    const usedTokens = systemTokens + pinnedTokens + recentRawTokens + artifactHandleTokens + toolSchemaTokens + toolResultTokens;
    const pressure = Math.min(1, (usedTokens + this.budgets.generationReserveTokens) / this.budgets.contextLimit);
    const provisional: ContextStats = {
      usedTokens, contextLimit: this.budgets.contextLimit, availableTokens: Math.max(0, this.budgets.contextLimit - usedTokens),
      safeHeadroomTokens: Math.max(0, this.budgets.contextLimit - usedTokens - this.budgets.generationReserveTokens),
      systemTokens, pinnedTokens, recentRawTokens, artifactHandleTokens, toolSchemaTokens, retrievedMemoryTokens, toolResultTokens,
      reservedTokens: this.budgets.generationReserveTokens, generationReserveTokens: this.budgets.generationReserveTokens, pressure,
      pressureLevel: "NORMAL",
    };
    provisional.pressureLevel = this.policyEngine.evaluate(provisional, this.budgets, sessionId ?? "global").level;
    return {
      pinned: pins,
      recentMessages,
      artifactHandles,
      toolSchemas,
      stats: {
        ...provisional,
      },
    };
  }

  /** Adds the currently exposed native-tool declaration cost to an existing visible context. */
  withToolSchemas(context: BuiltContext, toolSchemas: readonly string[]): BuiltContext {
    const toolSchemaTokens = toolSchemas.reduce((sum, schema) => sum + this.tokenEstimator.estimateText(schema), 0);
    const usedTokens = context.stats.usedTokens - context.stats.toolSchemaTokens + toolSchemaTokens;
    const pressure = Math.min(1, (usedTokens + context.stats.generationReserveTokens) / context.stats.contextLimit);
    const stats: ContextStats = { ...context.stats, usedTokens, availableTokens: Math.max(0, context.stats.contextLimit - usedTokens), safeHeadroomTokens: Math.max(0, context.stats.contextLimit - usedTokens - context.stats.generationReserveTokens), toolSchemaTokens, pressure, pressureLevel: this.policyEngine.evaluate({ ...context.stats, usedTokens, pressure }, this.budgets).level };
    return {
      ...context,
      toolSchemas,
      stats,
    };
  }

  private selectRecent(history: readonly HistoryMessage[]): HistoryMessage[] {
    const selected: HistoryMessage[] = [];
    let total = 0;
    for (const message of [...history].reverse()) {
      const tokens = this.tokenEstimator.estimateMessage(message);
      if (selected.length > 0 && total + tokens > this.budgets.recentRawTokenBudget) break;
      selected.push(message);
      total += tokens;
    }
    return selected.reverse();
  }

  private pinTokens(pins: Iterable<PinnedContext>): number {
    let total = 0;
    for (const pin of pins) total += this.tokenEstimator.estimateText(pin.content);
    return total;
  }

  private normalizePin(pin: PinnedContext): PinnedContext {
    return { ...pin, priority: pin.priority ?? (pin.source === "system" ? "critical" : "normal"), createdAt: pin.createdAt ?? new Date().toISOString() };
  }

  private hasDuplicateAgentPin(pin: PinnedContext): boolean {
    const normalized = pin.content.replace(/\s+/g, " ").trim().toLocaleLowerCase();
    return [...this.pins.values()].some((candidate) => candidate.source === "visible-agent" && candidate.sessionId === pin.sessionId && candidate.content.replace(/\s+/g, " ").trim().toLocaleLowerCase() === normalized);
  }

  private expirePins(sessionId: string): void {
    const turn = this.currentTurn(sessionId);
    for (const pin of this.pins.values()) if (pin.sessionId === sessionId && pin.expiresAtTurn !== undefined && pin.expiresAtTurn <= turn) {
      this.pins.delete(this.pinKey(pin));
      void this.events?.emit("context.pin.expired", { sessionId, pinId: pin.id }).catch(() => undefined);
      void this.events?.emit("context.pin.removed", { sessionId, pinId: pin.id, source: pin.source, reason: "expired" }).catch(() => undefined);
    }
  }

  private *applicablePins(pins: Iterable<PinnedContext>, sessionId?: string): Iterable<PinnedContext> {
    for (const pin of pins) {
      if (pin.sessionId === undefined || pin.sessionId === sessionId) yield pin;
    }
  }

  private pinKey(pin: Pick<PinnedContext, "id" | "sessionId">): string {
    return `${pin.sessionId ?? "*"}:${pin.id}`;
  }

  private validateBudgets(): void {
    const b = this.budgets;
    if (b.contextLimit <= 0 || b.generationReserveTokens < 0 || b.recentRawTokenBudget < 0 || b.pinnedTokenBudget < 0 || b.agentPinnedTokenBudget < 0 || b.retrievedMemoryTokenBudget < 0 || b.toolSchemaTokenBudget < 0 || b.toolResultTokenBudget < 0) {
      throw new Error("Context budgets must be non-negative and contextLimit must be positive");
    }
    if (b.generationReserveTokens >= b.contextLimit) throw new Error("generationReserveTokens must be below contextLimit");
    if (!(b.elevatedPressureThreshold < b.highPressureThreshold && b.highPressureThreshold <= b.compactionPressureThreshold && b.compactionPressureThreshold < b.emergencyPressureThreshold)) {
      throw new Error("Pressure thresholds must be strictly increasing");
    }
    if (b.pressureHysteresis < 0 || b.pressureHysteresis >= 0.2) throw new Error("pressureHysteresis must be between 0 and 0.2");
  }
}
