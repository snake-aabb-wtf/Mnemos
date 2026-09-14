import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ContextManager, type ContextBudgets } from "./context.js";
import type { ModelProvider } from "./model.js";

export const agentBudgetSchema = z.object({
  maxModelCalls: z.number().int().nonnegative().default(20),
  maxToolCalls: z.number().int().nonnegative().default(100),
  maxPtcExecutions: z.number().int().nonnegative().default(10),
  maxChildTasks: z.number().int().nonnegative().default(8),
  maxTokens: z.number().int().nonnegative().default(0),
  costBudget: z.number().nonnegative().default(0),
  maxInvocations: z.number().int().nonnegative().default(20),
}).strict();
export type AgentBudget = z.infer<typeof agentBudgetSchema>;

export interface AgentBudgetUsage {
  modelCalls: number;
  toolCalls: number;
  ptcExecutions: number;
  childTasks: number;
  tokens: number;
  cost: number;
  invocations: number;
}

export const agentToolPolicySchema = z.object({
  allowedNamespaces: z.array(z.string().min(1)).default([]),
  coreTools: z.array(z.string().min(1)).default([]),
  allowPtc: z.boolean().default(false),
  executionMode: z.enum(["native", "ptc", "both"]).default("native"),
}).strict();
export type AgentToolPolicy = z.infer<typeof agentToolPolicySchema>;

export const agentContextPolicySchema = z.object({
  contextLimit: z.number().int().positive().optional(),
  generationReserveTokens: z.number().int().nonnegative().optional(),
  recentRawTokenBudget: z.number().int().nonnegative().optional(),
  retrievedMemoryTokenBudget: z.number().int().nonnegative().optional(),
  toolSchemaTokenBudget: z.number().int().nonnegative().optional(),
}).strict();
export type AgentContextPolicy = z.infer<typeof agentContextPolicySchema>;

export const agentDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/),
  name: z.string().min(1).max(128),
  role: z.string().min(1).max(128),
  instructions: z.string().max(32_000),
  modelProfile: z.string().min(1).max(128),
  contextPolicy: agentContextPolicySchema.optional(),
  toolPolicy: agentToolPolicySchema.default({}),
  permissions: z.array(z.string().min(1)).default([]),
  budget: agentBudgetSchema.default({}),
  structuredOutput: z.boolean().default(false),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

export type AgentStatus = "idle" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export class AgentRegistry {
  private readonly definitions = new Map<string, AgentDefinition>();
  private readonly disabled = new Set<string>();

  register(definition: AgentDefinition): AgentDefinition {
    const parsed = agentDefinitionSchema.parse(definition);
    if (this.definitions.has(parsed.id)) throw new Error(`Agent definition already registered: ${parsed.id}`);
    this.definitions.set(parsed.id, cloneDefinition(parsed));
    this.disabled.delete(parsed.id);
    return cloneDefinition(parsed);
  }

  get(id: string): AgentDefinition | undefined {
    const definition = this.definitions.get(id);
    return definition === undefined || this.disabled.has(id) ? undefined : cloneDefinition(definition);
  }

  getIncludingDisabled(id: string): AgentDefinition | undefined {
    const definition = this.definitions.get(id);
    return definition === undefined ? undefined : cloneDefinition(definition);
  }

  list(options: { includeDisabled?: boolean } = {}): readonly AgentDefinition[] {
    return [...this.definitions.values()].filter((definition) => options.includeDisabled || !this.disabled.has(definition.id)).map(cloneDefinition);
  }

  /** Safe updates cannot mutate authority-bearing fields. Host code should register a new id for a new policy. */
  update(id: string, patch: Partial<Pick<AgentDefinition, "name" | "role" | "instructions" | "modelProfile" | "metadata">>): AgentDefinition {
    const current = this.definitions.get(id);
    if (current === undefined) throw new Error(`Unknown agent definition: ${id}`);
    const updated = agentDefinitionSchema.parse({ ...current, ...patch });
    this.definitions.set(id, cloneDefinition(updated));
    return cloneDefinition(updated);
  }

  disable(id: string): void {
    if (!this.definitions.has(id)) throw new Error(`Unknown agent definition: ${id}`);
    this.disabled.add(id);
  }

  enable(id: string): void {
    if (!this.definitions.has(id)) throw new Error(`Unknown agent definition: ${id}`);
    this.disabled.delete(id);
  }
}

export class AgentBudgetLedger {
  readonly usage: AgentBudgetUsage = { modelCalls: 0, toolCalls: 0, ptcExecutions: 0, childTasks: 0, tokens: 0, cost: 0, invocations: 0 };
  private reservedChildren = 0;
  constructor(readonly allocation: AgentBudget) {}

  reserveChild(requested: Partial<AgentBudget> = {}): AgentBudget {
    const remainingChildren = this.allocation.maxChildTasks - this.usage.childTasks;
    if (remainingChildren <= 0) throw new Error("child_task_limit_exceeded");
    // Omitted child limits inherit the parent's bounded allocation. Parsing the
    // schema defaults here would otherwise turn a small parent budget into an
    // accidental child-budget escalation (for example, 1 model call -> 20).
    const requestedBudget = agentBudgetSchema.parse({
      ...requested,
      maxModelCalls: requested.maxModelCalls ?? this.allocation.maxModelCalls,
      maxToolCalls: requested.maxToolCalls ?? this.allocation.maxToolCalls,
      maxPtcExecutions: requested.maxPtcExecutions ?? this.allocation.maxPtcExecutions,
      maxTokens: requested.maxTokens ?? this.allocation.maxTokens,
      costBudget: requested.costBudget ?? this.allocation.costBudget,
      maxInvocations: requested.maxInvocations ?? this.allocation.maxInvocations,
      maxChildTasks: requested.maxChildTasks ?? 0,
    });
    for (const key of ["maxModelCalls", "maxToolCalls", "maxPtcExecutions", "maxTokens", "maxInvocations"] as const) {
      if (this.allocation[key] > 0 && requestedBudget[key] > this.allocation[key]) throw new Error("child_budget_exceeded");
    }
    if (this.allocation.maxTokens > 0 && requestedBudget.maxTokens > this.allocation.maxTokens) throw new Error("child_budget_exceeded");
    if (this.allocation.costBudget > 0 && requestedBudget.costBudget > this.allocation.costBudget) throw new Error("child_budget_exceeded");
    this.reservedChildren += 1;
    return requestedBudget;
  }

  releaseChild(_reserved: AgentBudget): void { this.reservedChildren = Math.max(0, this.reservedChildren - 1); }

  consume(kind: keyof AgentBudgetUsage, amount = 1): void {
    const next = this.usage[kind] + amount;
    const limit = ({ modelCalls: this.allocation.maxModelCalls, toolCalls: this.allocation.maxToolCalls, ptcExecutions: this.allocation.maxPtcExecutions, childTasks: this.allocation.maxChildTasks, tokens: this.allocation.maxTokens, cost: this.allocation.costBudget, invocations: this.allocation.maxInvocations } as const)[kind];
    if (limit > 0 && next > limit) throw new Error(`budget_exceeded:${kind}`);
    this.usage[kind] = next;
  }
}

export class AgentRuntime {
  readonly instanceId = randomUUID();
  readonly context: ContextManager;
  readonly permissions: readonly string[];
  readonly budget: AgentBudgetLedger;
  readonly localState = new Map<string, unknown>();
  readonly abortController = new AbortController();
  status: AgentStatus = "idle";

  constructor(
    readonly definition: AgentDefinition,
    readonly sessionId: string,
    readonly taskId: string,
    readonly provider: ModelProvider,
    permissions: readonly string[],
    contextPolicy: Partial<ContextBudgets> = {},
    allocation?: Partial<AgentBudget>,
  ) {
    this.permissions = [...new Set(permissions)].sort();
    this.budget = new AgentBudgetLedger(agentBudgetSchema.parse({ ...definition.budget, ...allocation }));
    this.context = new ContextManager(undefined, contextPolicy);
  }

  cancel(): void {
    if (!this.abortController.signal.aborted) this.abortController.abort();
    this.status = "cancelled";
  }
}

export function intersectPermissions(parent: readonly string[], requested: readonly string[]): string[] {
  const allowed = new Set(parent);
  return [...new Set(requested.filter((permission) => allowed.has(permission)))].sort();
}

export function createBuiltinAgentDefinitions(): readonly AgentDefinition[] {
  return [
    { id: "visible.general", name: "Visible General", role: "visible", instructions: "Answer the user and coordinate bounded work.", modelProfile: "default", toolPolicy: { allowedNamespaces: ["memory", "history", "context", "state", "artifact", "tools"], coreTools: [], allowPtc: true, executionMode: "both" }, permissions: ["memory:read", "history:read", "artifact:read", "tools:read", "tool:execute"], budget: {}, metadata: { builtin: true } },
    { id: "hidden.memory", name: "Hidden Memory", role: "hidden-memory", instructions: "Consolidate validated evidence into derived Memory.", modelProfile: "memory", toolPolicy: { allowedNamespaces: ["memory", "history"], coreTools: [], allowPtc: false, executionMode: "native" }, permissions: ["memory:read", "memory:write", "history:read"], budget: { maxChildTasks: 0 }, metadata: { builtin: true } },
    { id: "planner", name: "Planner", role: "planner", instructions: "Produce a bounded structured plan and delegate only necessary work.", modelProfile: "reasoning", toolPolicy: { allowedNamespaces: ["memory", "history", "artifact", "context", "tools"], coreTools: [], allowPtc: true, executionMode: "both" }, permissions: ["memory:read", "history:read", "artifact:read", "tools:read", "tool:execute"], budget: { maxChildTasks: 8 }, structuredOutput: true, metadata: { builtin: true } },
    { id: "researcher", name: "Researcher", role: "researcher", instructions: "Gather evidence and return source-grounded findings.", modelProfile: "cheap", toolPolicy: { allowedNamespaces: ["memory", "history", "artifact", "tools"], coreTools: [], allowPtc: true, executionMode: "both" }, permissions: ["memory:read", "history:read", "artifact:read", "tools:read", "tool:execute"], budget: { maxChildTasks: 0 }, structuredOutput: true, metadata: { builtin: true } },
    { id: "coder", name: "Coder", role: "coder", instructions: "Implement the assigned bounded task and report artifacts.", modelProfile: "coding", toolPolicy: { allowedNamespaces: ["artifact", "state", "tools"], coreTools: [], allowPtc: true, executionMode: "both" }, permissions: ["artifact:read", "artifact:write", "state:read", "state:write", "tools:read", "tool:execute"], budget: { maxChildTasks: 0 }, structuredOutput: true, metadata: { builtin: true } },
    { id: "reviewer", name: "Reviewer", role: "reviewer", instructions: "Review task outputs and return approve/reject with evidence.", modelProfile: "reasoning", toolPolicy: { allowedNamespaces: ["artifact", "memory", "history", "state"], coreTools: [], allowPtc: false, executionMode: "native" }, permissions: ["artifact:read", "memory:read", "history:read", "state:read"], budget: { maxChildTasks: 0 }, structuredOutput: true, metadata: { builtin: true } },
  ].map((definition) => agentDefinitionSchema.parse(definition));
}

function cloneDefinition(definition: AgentDefinition): AgentDefinition {
  return structuredClone(definition);
}
