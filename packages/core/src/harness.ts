import pino, { type Logger } from "pino";
import { type CompactionPreparation, CompactionService, InMemoryContextCompactionStore } from "./compaction.js";
import { ContextManager, type ContextStats } from "./context.js";
import type { HistoryMessage, HistoryStore, StateStore } from "./contracts.js";
import { EventBus, type HarnessEventMap } from "./events.js";
import { VisibleAgent, type ModelProvider } from "./model.js";

export interface HarnessOptions {
  history: HistoryStore;
  state: StateStore;
  provider: ModelProvider;
  context?: ContextManager;
  /** Optional custom Phase 2 pipeline; a non-durable in-memory pipeline is supplied by default. */
  compaction?: CompactionService;
  events?: EventBus<HarnessEventMap>;
  systemPrompt?: string;
  logger?: Logger;
}

export class Harness {
  readonly context: ContextManager;
  readonly events: EventBus<HarnessEventMap>;
  private readonly agent: VisibleAgent;
  private readonly logger: Logger;
  private readonly systemPrompt: string;
  private readonly compaction: CompactionService;

  constructor(private readonly options: HarnessOptions) {
    this.context = options.context ?? new ContextManager();
    this.events = options.events ?? new EventBus<HarnessEventMap>();
    this.agent = new VisibleAgent(options.provider);
    this.systemPrompt = options.systemPrompt ?? "";
    this.compaction = options.compaction ?? new CompactionService({
      history: options.history,
      checkpoints: new InMemoryContextCompactionStore(),
      context: this.context,
    });
    this.logger = options.logger ?? pino({ name: "mnemos" });
  }

  async send(sessionId: string, content: string): Promise<HistoryMessage> {
    const received = await this.options.history.append({ sessionId, role: "user", content });
    await this.events.emit("message.received", { message: received });
    const beforeResponse = await this.prepareContext(sessionId);
    await this.emitEvictions(beforeResponse);
    await this.emitContextEvents(sessionId, beforeResponse.context.stats);

    const response = await this.agent.respond({ sessionId, input: content, context: beforeResponse.context });
    const generated = await this.options.history.append({
      sessionId,
      role: "assistant",
      content: response.content,
      metadata: response.metadata,
    });
    await this.events.emit("message.generated", { message: generated });
    const afterResponse = await this.prepareContext(sessionId);
    await this.emitEvictions(afterResponse);
    await this.emitContextEvents(sessionId, afterResponse.context.stats);
    this.logger.debug({ sessionId, messageId: generated.id }, "Generated model response");
    return generated;
  }

  getState<T extends Record<string, unknown>>(sessionId: string): Promise<T | undefined> {
    return this.options.state.get<T>(sessionId);
  }

  setState<T extends Record<string, unknown>>(sessionId: string, state: T): Promise<T> {
    return this.options.state.set(sessionId, state);
  }

  patchState<T extends Record<string, unknown>>(sessionId: string, patch: Partial<T>): Promise<T> {
    return this.options.state.patch<T>(sessionId, patch);
  }

  private async prepareContext(sessionId: string): Promise<CompactionPreparation> {
    return this.compaction.prepare(sessionId, this.systemPrompt);
  }

  private async emitEvictions(preparation: CompactionPreparation): Promise<void> {
    for (const eviction of preparation.evictions) await this.events.emit("context.evicted", eviction);
  }

  private async emitContextEvents(sessionId: string, stats: ContextStats): Promise<void> {
    await this.events.emit("context.pressure", { sessionId, stats });
    if (stats.pressure >= this.context.budgets.emergencyPressureThreshold) {
      await this.events.emit("context.compaction.requested", { sessionId, stats, reason: "emergency" });
    } else if (stats.pressure >= this.context.budgets.highPressureThreshold) {
      await this.events.emit("context.compaction.requested", { sessionId, stats, reason: "high" });
    }
  }
}
