import pino, { type Logger } from "pino";
import { ContextManager, type ContextStats } from "./context.js";
import type { HistoryMessage, HistoryStore, StateStore } from "./contracts.js";
import { EventBus, type HarnessEventMap } from "./events.js";
import { VisibleAgent, type ModelProvider } from "./model.js";

export interface HarnessOptions {
  history: HistoryStore;
  state: StateStore;
  provider: ModelProvider;
  context?: ContextManager;
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

  constructor(private readonly options: HarnessOptions) {
    this.context = options.context ?? new ContextManager();
    this.events = options.events ?? new EventBus<HarnessEventMap>();
    this.agent = new VisibleAgent(options.provider);
    this.systemPrompt = options.systemPrompt ?? "";
    this.logger = options.logger ?? pino({ name: "mnemos" });
  }

  async send(sessionId: string, content: string): Promise<HistoryMessage> {
    const received = await this.options.history.append({ sessionId, role: "user", content });
    await this.events.emit("message.received", { message: received });
    await this.emitContextEvents(sessionId);

    const history = await this.options.history.list(sessionId);
    const context = this.context.build(history, this.systemPrompt);
    const response = await this.agent.respond({ sessionId, input: content, context });
    const generated = await this.options.history.append({
      sessionId,
      role: "assistant",
      content: response.content,
      metadata: response.metadata,
    });
    await this.events.emit("message.generated", { message: generated });
    await this.emitContextEvents(sessionId);
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

  private async emitContextEvents(sessionId: string): Promise<void> {
    const stats = this.context.build(await this.options.history.list(sessionId), this.systemPrompt).stats;
    await this.events.emit("context.pressure", { sessionId, stats });
    if (stats.pressure >= this.context.budgets.emergencyPressureThreshold) {
      await this.events.emit("context.compaction.requested", { sessionId, stats, reason: "emergency" });
    } else if (stats.pressure >= this.context.budgets.highPressureThreshold) {
      await this.events.emit("context.compaction.requested", { sessionId, stats, reason: "high" });
    }
  }
}
