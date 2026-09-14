import type { ContextStats, ContextBudgets } from "./context.js";

export const contextPressureLevels = ["NORMAL", "ELEVATED", "HIGH", "COMPACTION", "EMERGENCY"] as const;
export type ContextPressureLevel = (typeof contextPressureLevels)[number];
export const CONTEXT_POLICY_VERSION = "context-policy/v1";

export function contextModelInstructions(): readonly string[] {
  return [
    CONTEXT_POLICY_VERSION,
    "Context telemetry is runtime-owned. Use context.inspect when a task becomes long or pressure is reported; do not inspect every turn.",
    "Pin only durable task constraints with context.pin, avoid repeated duplicates, and use a bounded turn TTL when appropriate. Runtime policy controls budgets and compaction boundaries.",
    "At higher pressure prefer compact retrieval, PTC for multi-step workflows, and Artifact handles for large data. The runtime may refuse a model invocation if safe headroom is unavailable.",
  ];
}

export const contextPolicyActions = [
  "continue_normal",
  "avoid_large_retrieval",
  "prefer_ptc",
  "prefer_artifact",
  "limit_memory_retrieval",
  "reduce_tool_result_budget",
  "unload_unused_dynamic_tools",
  "avoid_loading_more_tools",
  "request_compaction",
  "force_compaction",
  "do_not_invoke_model_until_context_reduced",
] as const;
export type ContextPolicyAction = (typeof contextPolicyActions)[number];

export interface ContextPolicyDecision {
  level: ContextPressureLevel;
  recommendations: readonly ContextPolicyAction[];
  enforced: boolean;
  effectiveRecentRawTarget: number;
  effectiveRetrievalTokenBudget: number;
  effectiveToolSchemaBudget: number;
  effectiveToolResultBudget: number;
  generationReserveTokens: number;
}

export interface ContextPolicySnapshot {
  sessionId: string;
  stats: ContextStats;
  decision: ContextPolicyDecision;
  capturedAt: string;
}

export interface ContextPolicyRuntimeState {
  loadedDynamicTools?: number;
  activePtcExecution?: boolean;
  retrievalTokenBudget?: number;
  toolSchemaTokenBudget?: number;
  toolResultTokenBudget?: number;
}

/** Deterministic, session-scoped policy with hysteresis around pressure thresholds. */
export class ContextPolicyEngine {
  private readonly levels = new Map<string, ContextPressureLevel>();

  evaluate(stats: ContextStats, budgets: ContextBudgets, sessionId = "global", state: ContextPolicyRuntimeState = {}): ContextPolicyDecision {
    const level = this.stableLevel(stats.pressure, budgets, sessionId);
    const scale = level === "NORMAL" ? 1 : level === "ELEVATED" ? 0.9 : level === "HIGH" ? 0.7 : level === "COMPACTION" ? 0.5 : 0.35;
    const recommendations: ContextPolicyAction[] = level === "NORMAL"
      ? ["continue_normal"]
      : level === "ELEVATED"
        ? ["avoid_large_retrieval"]
        : level === "HIGH"
          ? ["prefer_ptc", "prefer_artifact", "limit_memory_retrieval", "unload_unused_dynamic_tools", "avoid_loading_more_tools"]
          : level === "COMPACTION"
            ? ["prefer_ptc", "prefer_artifact", "limit_memory_retrieval", "reduce_tool_result_budget", "request_compaction", "avoid_loading_more_tools"]
            : ["prefer_ptc", "prefer_artifact", "limit_memory_retrieval", "reduce_tool_result_budget", "unload_unused_dynamic_tools", "force_compaction", "do_not_invoke_model_until_context_reduced"];
    return {
      level,
      recommendations,
      enforced: level === "EMERGENCY",
      effectiveRecentRawTarget: Math.max(1, Math.floor(budgets.recentRawTokenBudget * scale)),
      effectiveRetrievalTokenBudget: Math.max(1, Math.floor((state.retrievalTokenBudget ?? budgets.retrievedMemoryTokenBudget) * scale)),
      effectiveToolSchemaBudget: Math.max(1, Math.floor((state.toolSchemaTokenBudget ?? budgets.toolSchemaTokenBudget) * scale)),
      effectiveToolResultBudget: Math.max(1, Math.floor((state.toolResultTokenBudget ?? budgets.toolResultTokenBudget) * scale)),
      generationReserveTokens: budgets.generationReserveTokens,
    };
  }

  clear(sessionId?: string): void {
    if (sessionId === undefined) this.levels.clear();
    else this.levels.delete(sessionId);
  }

  private stableLevel(pressure: number, budgets: ContextBudgets, sessionId: string): ContextPressureLevel {
    const prior = this.levels.get(sessionId);
    const next = pressure >= budgets.emergencyPressureThreshold
      ? "EMERGENCY"
      : pressure >= budgets.compactionPressureThreshold
        ? "COMPACTION"
        : pressure >= budgets.highPressureThreshold
          ? "HIGH"
          : pressure >= budgets.elevatedPressureThreshold
            ? "ELEVATED"
            : "NORMAL";
    if (prior !== undefined && rank(next) < rank(prior) && pressure >= lowerThreshold(prior, budgets) - budgets.pressureHysteresis) return prior;
    this.levels.set(sessionId, next);
    return next;
  }
}

function rank(level: ContextPressureLevel): number {
  return contextPressureLevels.indexOf(level);
}

function lowerThreshold(level: ContextPressureLevel, budgets: ContextBudgets): number {
  switch (level) {
    case "EMERGENCY": return budgets.emergencyPressureThreshold;
    case "COMPACTION": return budgets.compactionPressureThreshold;
    case "HIGH": return budgets.highPressureThreshold;
    case "ELEVATED": return budgets.elevatedPressureThreshold;
    default: return 0;
  }
}
