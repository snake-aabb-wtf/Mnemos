import pino, { type Logger } from "pino";
import { type CompactionPreparation, CompactionService, InMemoryContextCompactionStore } from "./compaction.js";
import { ContextManager, type ContextStats } from "./context.js";
import type { HistoryMessage, HistoryStore, StateStore } from "./contracts.js";
import { EventBus, type HarnessEventMap } from "./events.js";
import { VisibleAgent, type ModelProvider, type ModelToolCall } from "./model.js";
import { ToolDispatcher, ToolRegistry, type ToolDispatchContext, type ToolPermission } from "./tool.js";

export interface HarnessToolRuntimeOptions {
  registry: ToolRegistry;
  dispatcher: ToolDispatcher;
  agentId?: string;
  principal?: string;
  /** Host-granted capabilities. Model-generated call arguments never affect this set. */
  grantedPermissions?: readonly ToolPermission[];
  maxToolIterations?: number;
}

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
  toolRuntime?: HarnessToolRuntimeOptions;
}

export class Harness {
  readonly context: ContextManager;
  readonly events: EventBus<HarnessEventMap>;
  private readonly agent: VisibleAgent;
  private readonly logger: Logger;
  private readonly systemPrompt: string;
  private readonly compaction: CompactionService;
  private readonly toolRuntime?: Required<Omit<HarnessToolRuntimeOptions, "registry" | "dispatcher">> & Pick<HarnessToolRuntimeOptions, "registry" | "dispatcher">;

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
    if (options.toolRuntime) {
      const maxToolIterations = options.toolRuntime.maxToolIterations ?? 8;
      if (!Number.isInteger(maxToolIterations) || maxToolIterations < 0) throw new Error("maxToolIterations must be a non-negative integer");
      this.toolRuntime = {
        registry: options.toolRuntime.registry,
        dispatcher: options.toolRuntime.dispatcher,
        agentId: options.toolRuntime.agentId ?? "visible-agent",
        principal: options.toolRuntime.principal ?? "visible-agent",
        grantedPermissions: [...(options.toolRuntime.grantedPermissions ?? [])],
        maxToolIterations,
      };
    }
    this.logger = options.logger ?? pino({ name: "mnemos" });
  }

  async send(sessionId: string, content: string): Promise<HistoryMessage> {
    const received = await this.options.history.append({ sessionId, role: "user", content });
    await this.events.emit("message.received", { message: received });
    const beforeResponse = await this.prepareContext(sessionId);
    await this.emitEvictions(beforeResponse);
    await this.emitContextEvents(sessionId, beforeResponse.context.stats);

    let prepared = beforeResponse;
    let toolIterations = 0;
    while (true) {
      const response = await this.agent.respond({
        sessionId,
        input: content,
        context: prepared.context,
        ...(this.toolRuntime === undefined ? {} : { tools: this.toolRuntime.registry.nativeDeclarations() }),
      });
      if (response.kind !== "tool-calls") {
        const generated = await this.appendAssistant(sessionId, response.content, response.metadata);
        const afterResponse = await this.prepareContext(sessionId);
        await this.emitEvictions(afterResponse);
        await this.emitContextEvents(sessionId, afterResponse.context.stats);
        this.logger.debug({ sessionId, messageId: generated.id }, "Generated model response");
        return generated;
      }
      if (!this.toolRuntime) {
        return this.appendAssistant(sessionId, "Tool Runtime is not configured for this conversation.");
      }
      if (toolIterations >= this.toolRuntime.maxToolIterations) {
        return this.appendAssistant(sessionId, "Tool iteration limit reached before a final response.");
      }
      if (response.toolCalls.length === 0) {
        return this.appendAssistant(sessionId, "The model returned an empty tool-call response.");
      }
      await this.executeToolCalls(sessionId, response.toolCalls);
      toolIterations += 1;
      prepared = await this.prepareContext(sessionId);
      await this.emitEvictions(prepared);
      await this.emitContextEvents(sessionId, prepared.context.stats);
    }
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
    return this.compaction.prepare(sessionId, this.systemPrompt, this.toolSchemaTexts());
  }

  private async executeToolCalls(sessionId: string, calls: readonly ModelToolCall[]): Promise<void> {
    if (!this.toolRuntime) return;
    const context: ToolDispatchContext = {
      sessionId,
      agentId: this.toolRuntime.agentId,
      principal: this.toolRuntime.principal,
      grantedPermissions: this.toolRuntime.grantedPermissions,
    };
    for (const call of calls) {
      const transactionId = typeof call.id === "string" && call.id.length > 0 ? call.id : "invalid-tool-call";
      const requested = await this.options.history.append({
        sessionId,
        role: "assistant",
        content: this.historyToolCallContent(call),
        metadata: { transactionId, toolCallId: transactionId, toolName: call.name, kind: "tool-call" },
      });
      await this.events.emit("message.generated", { message: requested });
      const result = await this.toolRuntime.dispatcher.dispatch(call, context);
      await this.options.history.append({
        sessionId,
        role: "tool",
        content: JSON.stringify(result),
        metadata: {
          transactionId,
          toolCallId: result.callId,
          toolName: result.toolName,
          status: result.status,
          ...(result.status === "success" ? { outputKind: result.output.kind } : { errorCode: result.error.code }),
        },
      });
    }
  }

  private async appendAssistant(sessionId: string, content: string, metadata?: Record<string, unknown>): Promise<HistoryMessage> {
    const generated = await this.options.history.append({
      sessionId,
      role: "assistant",
      content,
      ...(metadata === undefined ? {} : { metadata }),
    });
    await this.events.emit("message.generated", { message: generated });
    return generated;
  }

  private toolSchemaTexts(): readonly string[] {
    if (!this.toolRuntime) return [];
    return this.toolRuntime.registry.nativeDeclarations().map((declaration) => JSON.stringify(declaration));
  }

  private historyToolCallContent(call: ModelToolCall): string {
    let argumentsText: string | undefined;
    try {
      argumentsText = JSON.stringify(call.arguments);
    } catch {
      return JSON.stringify({ callId: call.id, toolName: call.name, argumentsUnavailable: true });
    }
    if (argumentsText === undefined) return JSON.stringify({ callId: call.id, toolName: call.name, argumentsUnavailable: true });
    const maximumBytes = 16 * 1024;
    if (Buffer.byteLength(argumentsText) > maximumBytes) {
      return JSON.stringify({ callId: call.id, toolName: call.name, argumentsPreview: argumentsText.slice(0, maximumBytes), argumentsTruncated: true });
    }
    return JSON.stringify({ callId: call.id, toolName: call.name, arguments: JSON.parse(argumentsText) as unknown });
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
