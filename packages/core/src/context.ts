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

export interface PinnedContext {
  id: string;
  content: string;
  source: "system" | "automatic" | "visible-agent";
}

export interface ContextStats {
  usedTokens: number;
  contextLimit: number;
  systemTokens: number;
  pinnedTokens: number;
  recentRawTokens: number;
  retrievedMemoryTokens: number;
  toolResultTokens: number;
  reservedTokens: number;
  pressure: number;
}

export interface BuiltContext {
  pinned: readonly PinnedContext[];
  recentMessages: readonly HistoryMessage[];
  stats: ContextStats;
}

export class ContextManager {
  private readonly pins = new Map<string, PinnedContext>();
  readonly budgets: ContextBudgets;

  constructor(
    private readonly estimator: TokenEstimator = new CharacterTokenEstimator(),
    budgets: Partial<ContextBudgets> = {},
  ) {
    this.budgets = { ...defaultContextBudgets, ...budgets };
    this.validateBudgets();
  }

  addPin(pin: PinnedContext): void {
    const next = new Map(this.pins);
    next.set(pin.id, pin);
    if (this.pinTokens(next.values()) > this.budgets.pinnedTokenBudget) {
      throw new Error("Pinned context would exceed its token budget");
    }
    this.pins.set(pin.id, pin);
  }

  removePin(id: string): boolean {
    return this.pins.delete(id);
  }

  listPins(): readonly PinnedContext[] {
    return [...this.pins.values()];
  }

  build(history: readonly HistoryMessage[], systemPrompt = ""): BuiltContext {
    const recentMessages = this.selectRecent(history);
    const systemTokens = this.estimator.estimateText(systemPrompt);
    const pinnedTokens = this.pinTokens(this.pins.values());
    const recentRawTokens = recentMessages.reduce((sum, message) => sum + this.estimator.estimateMessage(message), 0);
    const usedTokens = systemTokens + pinnedTokens + recentRawTokens;
    const pressure = Math.min(1, (usedTokens + this.budgets.reservedTokens) / this.budgets.contextLimit);
    return {
      pinned: this.listPins(),
      recentMessages,
      stats: {
        usedTokens,
        contextLimit: this.budgets.contextLimit,
        systemTokens,
        pinnedTokens,
        recentRawTokens,
        retrievedMemoryTokens: 0,
        toolResultTokens: 0,
        reservedTokens: this.budgets.reservedTokens,
        pressure,
      },
    };
  }

  private selectRecent(history: readonly HistoryMessage[]): HistoryMessage[] {
    const selected: HistoryMessage[] = [];
    let total = 0;
    for (const message of [...history].reverse()) {
      const tokens = this.estimator.estimateMessage(message);
      if (selected.length > 0 && total + tokens > this.budgets.recentRawTokenBudget) break;
      selected.push(message);
      total += tokens;
    }
    return selected.reverse();
  }

  private pinTokens(pins: Iterable<PinnedContext>): number {
    let total = 0;
    for (const pin of pins) total += this.estimator.estimateText(pin.content);
    return total;
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
