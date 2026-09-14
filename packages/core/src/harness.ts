import pino, { type Logger } from "pino";
import { type CompactionPreparation, CompactionService, InMemoryContextCompactionStore } from "./compaction.js";
import { ContextManager, type ContextStats } from "./context.js";
import type { HistoryMessage, HistoryStore, StateStore } from "./contracts.js";
import { EventBus, type HarnessEventMap } from "./events.js";
import { VisibleAgent, type ModelProvider, type ModelToolCall } from "./model.js";
import { ToolDispatcher, ToolRegistry, type ToolDispatchContext, type ToolPermission } from "./tool.js";
import { type ToolDiscoveryRuntime } from "./tool-discovery.js";
import { contextModelInstructions } from "./context-policy.js";
import { ptcModelInstructions, runCodeToolName, type PtcRuntime, type ToolExecutionMode } from "./ptc.js";
import type { MetricsSink, Tracer } from "./observability.js";
import { SessionMutex } from "./lifecycle.js";
import { ReliableModelProvider, type ProviderReliabilityExecutor } from "./provider-reliability.js";

export interface HarnessToolRuntimeOptions {
  registry: ToolRegistry;
  dispatcher: ToolDispatcher;
  agentId?: string;
  principal?: string;
  /** Host-granted capabilities. Model-generated call arguments never affect this set. */
  grantedPermissions?: readonly ToolPermission[];
  maxToolIterations?: number;
  /** Native calls, PTC-only run_code, or both. The default preserves a Phase 7-only Registry. */
  executionMode?: ToolExecutionMode;
  /** Required whenever PTC is exposed to the Visible Agent. */
  ptc?: PtcRuntime;
  /** Optional Phase 9 dynamic discovery catalog and session-scoped loaded set. */
  discovery?: ToolDiscoveryRuntime;
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
  metrics?: MetricsSink;
  tracer?: Tracer;
  /** Optional provider policy adapter; omitted for embedders that wrap the provider themselves. */
  providerReliability?: ProviderReliabilityExecutor;
  toolRuntime?: HarnessToolRuntimeOptions;
}

export class Harness {
  readonly context: ContextManager;
  readonly events: EventBus<HarnessEventMap>;
  private readonly agent: VisibleAgent;
  private readonly logger: Logger;
  private readonly metrics?: MetricsSink;
  private readonly tracer?: Tracer;
  private readonly sessionMutex = new SessionMutex();
  private readonly systemPrompt: string;
  private readonly compaction: CompactionService;
  private readonly toolRuntime?: Required<Omit<HarnessToolRuntimeOptions, "registry" | "dispatcher" | "ptc" | "executionMode" | "discovery">>
    & Pick<HarnessToolRuntimeOptions, "registry" | "dispatcher" | "ptc">
    & { executionMode: ToolExecutionMode; discovery?: ToolDiscoveryRuntime };

  constructor(private readonly options: HarnessOptions) {
    this.context = options.context ?? new ContextManager();
    this.events = options.events ?? new EventBus<HarnessEventMap>();
    this.context.attachEvents(this.events);
    this.agent = new VisibleAgent(options.providerReliability === undefined ? options.provider : new ReliableModelProvider(options.provider, options.providerReliability));
    this.systemPrompt = options.systemPrompt ?? "";
    this.compaction = options.compaction ?? new CompactionService({
      history: options.history,
      checkpoints: new InMemoryContextCompactionStore(),
      context: this.context,
    });
    if (options.toolRuntime) {
      const maxToolIterations = options.toolRuntime.maxToolIterations ?? 8;
      if (!Number.isInteger(maxToolIterations) || maxToolIterations < 0) throw new Error("maxToolIterations must be a non-negative integer");
      const executionMode = options.toolRuntime.executionMode
        ?? (options.toolRuntime.ptc !== undefined && options.toolRuntime.registry.has(runCodeToolName) ? "both" : "native");
      if (executionMode !== "native" && (options.toolRuntime.ptc === undefined || !options.toolRuntime.registry.has(runCodeToolName))) {
        throw new Error("PTC execution mode requires a registered run_code tool and PtcRuntime");
      }
      this.toolRuntime = {
        registry: options.toolRuntime.registry,
        dispatcher: options.toolRuntime.dispatcher,
        agentId: options.toolRuntime.agentId ?? "visible-agent",
        principal: options.toolRuntime.principal ?? "visible-agent",
        grantedPermissions: [...(options.toolRuntime.grantedPermissions ?? [])],
        maxToolIterations,
        executionMode,
        ...(options.toolRuntime.ptc === undefined ? {} : { ptc: options.toolRuntime.ptc }),
        ...(options.toolRuntime.discovery === undefined ? {} : { discovery: options.toolRuntime.discovery }),
      };
    }
    this.logger = options.logger ?? pino({ name: "mnemos" });
    this.metrics = options.metrics;
    this.tracer = options.tracer;
  }

  async send(sessionId: string, content: string): Promise<HistoryMessage> {
    return this.sessionMutex.run(sessionId, () => this.sendUnlocked(sessionId, content));
  }

  private async sendUnlocked(sessionId: string, content: string): Promise<HistoryMessage> {
    const startedAt = Date.now();
    const span = this.tracer?.startSpan("harness.request", undefined, { sessionId, agentId: this.toolRuntime?.agentId ?? "visible-agent" });
    this.metrics?.increment("requests.total");
    this.context.advanceTurn(sessionId);
    const received = await this.options.history.append({ sessionId, role: "user", content });
    await this.events.emit("message.received", { message: received });
    const beforeResponse = await this.prepareContext(sessionId);
    await this.emitEvictions(beforeResponse);

    let prepared = beforeResponse;
    let toolIterations = 0;
    while (true) {
      const preflight = await this.preflightContext(sessionId, prepared);
      if (!preflight.safe) { span?.end("error"); this.metrics?.increment("requests.failed", 1, { reason: "context_limit" }); return this.appendAssistant(sessionId, "Context limit reached; the runtime could not safely reduce the working context before model invocation."); }
      this.metrics?.increment("model.calls");
      const response = await this.agent.respond({
        sessionId,
        input: content,
        context: prepared.context,
        ...(this.toolRuntime === undefined ? {} : { tools: this.modelTools(sessionId), runtimeInstructions: this.runtimeInstructions(sessionId) }),
      });
      if (response.kind !== "tool-calls") {
        const generated = await this.appendAssistant(sessionId, response.content, response.metadata);
        const afterResponse = await this.prepareContext(sessionId);
        await this.emitEvictions(afterResponse);
        await this.emitContextEvents(sessionId, afterResponse.context.stats);
        this.logger.debug({ sessionId, messageId: generated.id }, "Generated model response");
        span?.end("ok"); this.metrics?.observe("request.duration_ms", Date.now() - startedAt); return generated;
      }
      if (!this.toolRuntime) {
        span?.end("error"); return this.appendAssistant(sessionId, "Tool Runtime is not configured for this conversation.");
      }
      if (toolIterations >= this.toolRuntime.maxToolIterations) {
        span?.end("error"); this.metrics?.increment("requests.failed", 1, { reason: "tool_iterations" }); return this.appendAssistant(sessionId, "Tool iteration limit reached before a final response.");
      }
      if (response.toolCalls.length === 0) {
        span?.end("error"); return this.appendAssistant(sessionId, "The model returned an empty tool-call response.");
      }
      await this.executeToolCalls(sessionId, response.toolCalls);
      toolIterations += 1;
      prepared = await this.prepareContext(sessionId);
      await this.emitEvictions(prepared);
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
    const toolSchemas = this.toolSchemaTexts(sessionId);
    this.context.setSessionToolSchemas(sessionId, toolSchemas);
    this.context.setSessionSystemPrompt(sessionId, this.systemPrompt);
    return this.compaction.prepare(sessionId, this.systemPrompt, toolSchemas);
  }

  private async preflightContext(sessionId: string, preparation: CompactionPreparation): Promise<{ safe: boolean }> {
    const stats = preparation.context.stats;
    const decision = this.context.policyDecision(sessionId, stats, {
      loadedDynamicTools: this.toolRuntime?.discovery?.snapshot(sessionId, this.toolRuntime.grantedPermissions).dynamicNames.length,
    });
    if (this.toolRuntime?.discovery) {
      const unloaded = this.toolRuntime.discovery.applyContextPolicy(sessionId, decision.effectiveToolSchemaBudget);
      await this.toolRuntime.discovery.emitUnloaded(sessionId, this.toolRuntime.agentId, unloaded, "budget");
    }
    await this.emitContextEvents(sessionId, stats, decision);
    if (this.context.isSafeForModel(preparation.context)) return { safe: true };
    const reduced = await this.prepareContext(sessionId);
    await this.emitEvictions(reduced);
    await this.emitContextEvents(sessionId, reduced.context.stats, this.context.policyDecision(sessionId, reduced.context.stats));
    return { safe: this.context.isSafeForModel(reduced.context) };
  }

  private async executeToolCalls(sessionId: string, calls: readonly ModelToolCall[]): Promise<void> {
    if (!this.toolRuntime) return;
    const context: ToolDispatchContext = {
      sessionId,
      agentId: this.toolRuntime.agentId,
      principal: this.toolRuntime.principal,
      grantedPermissions: this.toolRuntime.grantedPermissions,
      allowedToolNames: this.dispatchableToolNames(sessionId),
    };
    for (const call of calls) {
      this.metrics?.increment("tool.calls", 1, { tool: call.name });
      const transactionId = typeof call.id === "string" && call.id.length > 0 ? call.id : "invalid-tool-call";
      const requested = await this.options.history.append({
        sessionId,
        role: "assistant",
        content: this.historyToolCallContent(call),
        metadata: { transactionId, toolCallId: transactionId, toolName: call.name, kind: "tool-call" },
      });
      await this.events.emit("message.generated", { message: requested });
      const result = await this.toolRuntime.dispatcher.dispatch(call, context);
      this.metrics?.increment(result.status === "success" ? "tool.successes" : "tool.failures", 1, { tool: call.name });
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

  private toolSchemaTexts(sessionId: string): readonly string[] {
    if (!this.toolRuntime) return [];
    return [
      ...this.modelTools(sessionId).map((declaration) => JSON.stringify(declaration)),
      ...this.runtimeInstructions(sessionId),
    ];
  }

  private modelTools(sessionId: string) {
    if (!this.toolRuntime) return [];
    const declarations = this.toolRuntime.discovery?.declarations(sessionId, this.toolRuntime.grantedPermissions)
      ?? this.toolRuntime.registry.nativeDeclarations();
    if (this.toolRuntime.executionMode === "native") return declarations.filter((tool) => tool.name !== runCodeToolName);
    if (this.toolRuntime.executionMode === "ptc") return declarations.filter((tool) => tool.name === runCodeToolName);
    return declarations;
  }

  private dispatchableToolNames(sessionId: string): readonly import("./tool.js").ToolName[] {
    if (!this.toolRuntime) return [];
    return this.toolRuntime.discovery?.dispatchableNames(sessionId, this.toolRuntime.grantedPermissions)
      ?? this.toolRuntime.registry.list().map((tool) => tool.name);
  }

  private runtimeInstructions(sessionId: string): readonly string[] {
    if (!this.toolRuntime) return [];
    const instructions: string[] = [];
    if (this.toolRuntime.executionMode !== "native" && this.toolRuntime.ptc !== undefined) instructions.push(...ptcModelInstructions(this.toolRuntime.ptc.sdkDescription(this.dispatchableToolNames(sessionId))));
    instructions.push(...contextModelInstructions());
    return instructions;
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

  private readonly lastPressureLevels = new Map<string, ContextStats["pressureLevel"]>();

  private async emitContextEvents(sessionId: string, stats: ContextStats, decision = this.context.policyDecision(sessionId, stats)): Promise<void> {
    await this.events.emit("context.pressure", { sessionId, stats });
    const previous = this.lastPressureLevels.get(sessionId);
    if (previous !== stats.pressureLevel) await this.events.emit("context.pressure.changed", { sessionId, previous, stats });
    this.lastPressureLevels.set(sessionId, stats.pressureLevel);
    await this.events.emit("context.policy.applied", { sessionId, decision, enforced: decision.enforced });
    if (stats.pressureLevel === "EMERGENCY") {
      await this.events.emit("context.compaction.requested", { sessionId, stats, reason: "emergency" });
    } else if (stats.pressureLevel === "HIGH" || stats.pressureLevel === "COMPACTION") {
      await this.events.emit("context.compaction.requested", { sessionId, stats, reason: "high" });
    }
  }
}
