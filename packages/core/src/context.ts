import { z } from "zod";
import type { ArtifactHandle } from "./artifact.js";
import type { HistoryMessage } from "./contracts.js";

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
  recentRawTokenBudget: number;
  pinnedTokenBudget: number;
  softPressureThreshold: number;
  highPressureThreshold: number;
  emergencyPressureThreshold: number;
}

export const defaultContextBudgets: ContextBudgets = {
  contextLimit: 128_000,
  reservedTokens: 20_000,
  recentRawTokenBudget: 48_000,
  pinnedTokenBudget: 16_000,
  softPressureThreshold: 0.6,
  highPressureThreshold: 0.85,
  emergencyPressureThreshold: 0.92,
};

export const pinnedContextSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  source: z.enum(["system", "automatic", "visible-agent"]),
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
  pressure: number;
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
  readonly budgets: ContextBudgets;

  constructor(
    private readonly tokenEstimator: TokenEstimator = new CharacterTokenEstimator(),
    budgets: Partial<ContextBudgets> = {},
  ) {
    this.budgets = { ...defaultContextBudgets, ...budgets };
    this.validateBudgets();
  }

  addPin(pin: PinnedContext): void {
    const next = new Map(this.pins);
    next.set(this.pinKey(pin), pin);
    if (this.pinTokens(this.applicablePins(next.values(), pin.sessionId)) > this.budgets.pinnedTokenBudget) {
      throw new Error("Pinned context would exceed its token budget");
    }
    this.pins.set(this.pinKey(pin), pin);
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

  listPins(sessionId?: string): readonly PinnedContext[] {
    return [...this.applicablePins(this.pins.values(), sessionId)];
  }

  getTokenEstimator(): TokenEstimator {
    return this.tokenEstimator;
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
    const usedTokens = systemTokens + pinnedTokens + recentRawTokens + artifactHandleTokens + toolSchemaTokens + toolResultTokens;
    const pressure = Math.min(1, (usedTokens + this.budgets.reservedTokens) / this.budgets.contextLimit);
    return {
      pinned: pins,
      recentMessages,
      artifactHandles,
      toolSchemas,
      stats: {
        usedTokens,
        contextLimit: this.budgets.contextLimit,
        systemTokens,
        pinnedTokens,
        recentRawTokens,
        artifactHandleTokens,
        toolSchemaTokens,
        retrievedMemoryTokens: 0,
        toolResultTokens,
        reservedTokens: this.budgets.reservedTokens,
        pressure,
      },
    };
  }

  /** Adds the currently exposed native-tool declaration cost to an existing visible context. */
  withToolSchemas(context: BuiltContext, toolSchemas: readonly string[]): BuiltContext {
    const toolSchemaTokens = toolSchemas.reduce((sum, schema) => sum + this.tokenEstimator.estimateText(schema), 0);
    const usedTokens = context.stats.usedTokens - context.stats.toolSchemaTokens + toolSchemaTokens;
    const pressure = Math.min(1, (usedTokens + context.stats.reservedTokens) / context.stats.contextLimit);
    return {
      ...context,
      toolSchemas,
      stats: { ...context.stats, usedTokens, toolSchemaTokens, pressure },
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
    if (b.contextLimit <= 0 || b.reservedTokens < 0 || b.recentRawTokenBudget < 0 || b.pinnedTokenBudget < 0) {
      throw new Error("Context budgets must be non-negative and contextLimit must be positive");
    }
    if (b.reservedTokens >= b.contextLimit) throw new Error("reservedTokens must be below contextLimit");
    if (!(b.softPressureThreshold < b.highPressureThreshold && b.highPressureThreshold < b.emergencyPressureThreshold)) {
      throw new Error("Pressure thresholds must be strictly increasing");
    }
  }
}
