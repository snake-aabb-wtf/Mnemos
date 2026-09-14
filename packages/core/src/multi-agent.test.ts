import { describe, expect, it } from "vitest";
import {
  AgentRegistry,
  AgentBudgetLedger,
  agentBudgetSchema,
  AgentRuntime,
  AgentArtifactWorkspace,
  EventBus,
  HandoffContextBuilder,
  InMemoryAgentTaskStore,
  InMemoryMetricsSink,
  MockModelProvider,
  MultiAgentOrchestrator,
  TaskManager,
  createBuiltinAgentDefinitions,
  agentCanUseTool,
  memoryQueryForAgent,
  type ModelRequest,
} from "./index.js";

function registry(): AgentRegistry {
  const value = new AgentRegistry();
  for (const definition of createBuiltinAgentDefinitions()) value.register(definition);
  return value;
}

function jsonProvider(handler: (request: ModelRequest) => unknown): MockModelProvider {
  return new MockModelProvider(async (request) => ({ content: JSON.stringify(await handler(request)) }));
}

describe("Phase 14 multi-agent runtime", () => {
  it("validates definitions, stable IDs, safe updates, and disable lifecycle", () => {
    const agents = new AgentRegistry();
    const definition = createBuiltinAgentDefinitions().find((candidate) => candidate.id === "researcher")!;
    agents.register(definition);
    expect(() => agents.register(definition)).toThrow("already registered");
    expect(agents.update("researcher", { instructions: "new" }).instructions).toBe("new");
    expect(agents.get("researcher")?.permissions).toEqual(definition.permissions);
    agents.disable("researcher");
    expect(agents.get("researcher")).toBeUndefined();
    expect(agents.getIncludingDisabled("researcher")?.id).toBe("researcher");
  });

  it("builds bounded handoffs with references instead of copying large payloads", () => {
    const agents = registry();
    const task = new TaskManager(new InMemoryAgentTaskStore(), agents);
    return task.create({ sessionId: "s", createdBy: "planner", assignedAgentId: "researcher", objective: "investigate", input: {}, outputReferences: [], memoryReferences: [], artifactReferences: [], dependencyIds: [], failurePolicy: "fail-fast", maxAttempts: 3, metadata: {} }).then((created) => {
      const handoff = new HandoffContextBuilder(80, 320).build({ task: created, senderAgentId: "planner", receiver: agents.get("researcher")!, summary: "x".repeat(10_000), artifactRefs: ["artifact://result"], memoryRefs: ["memory-1"], sharedState: { milestone: "research" } });
      expect(handoff.tokenEstimate).toBeLessThanOrEqual(80);
      expect(handoff.byteLength).toBeLessThanOrEqual(320);
      expect(handoff.artifactRefs).toEqual(["artifact://result"]);
    });
  });

  it("creates a structured plan, executes independent research in parallel, and respects dependencies", async () => {
    const agents = registry();
    let active = 0;
    let peak = 0;
    const planner = jsonProvider(() => ({ kind: "plan", summary: "research then code", tasks: [
      { agentId: "researcher", objective: "research A", dependencies: [] },
      { agentId: "researcher", objective: "research B", dependencies: [] },
      { agentId: "coder", objective: "implement", dependencies: [0, 1] },
    ] }));
    const researcher = jsonProvider(async () => { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 5)); active -= 1; return { kind: "result", summary: "evidence" }; });
    const coder = jsonProvider(() => ({ kind: "result", summary: "implemented", artifactRefs: ["artifact://code"] }));
    const metrics = new InMemoryMetricsSink();
    const orchestrator = new MultiAgentOrchestrator({ registry: agents, providers: { reasoning: planner, cheap: researcher, coding: coder }, hostPermissions: ["memory:read", "history:read", "artifact:read", "artifact:write", "tools:read", "tool:execute", "state:read", "state:write"], maxConcurrentAgents: 3, maxConcurrentAgentsPerSession: 2, metrics });
    const root = await orchestrator.createRoot({ sessionId: "s", objective: "ship feature", agentId: "planner" });
    const result = await orchestrator.run(root.id);
    expect(result.status).toBe("completed");
    expect(result.tasks.filter((task) => task.status === "completed")).toHaveLength(4);
    expect(peak).toBe(2);
    expect(Object.entries(metrics.snapshot().counters).filter(([key]) => key.startsWith("agent.completed")).reduce((sum, [, value]) => sum + value, 0)).toBe(4);
  });

  it("inherits permissions and budgets when delegating", async () => {
    const agents = registry();
    const orchestrator = new MultiAgentOrchestrator({ registry: agents, providers: {}, hostPermissions: ["memory:read"], maxChildTasks: 2, toolInvoker: async (request) => ({ toolName: request.toolName, agentId: request.agentId }) });
    const root = await orchestrator.createRoot({ sessionId: "s", objective: "delegate", agentId: "planner" });
    const runtime = new AgentRuntime(agents.get("planner")!, "s", root.id, jsonProvider(() => ({ kind: "result", summary: "ok" })), ["memory:read"]);
    const child = await orchestrator.delegate(runtime, { agentId: "coder", objective: "write" });
    expect(child.metadata.effectivePermissions).toEqual([]);
    await expect(orchestrator.invokeTool(runtime, "state.patch", {})).rejects.toThrow("agent_tool_not_exposed");
    await expect(orchestrator.executePtc(runtime, async () => "ok")).resolves.toBe("ok");
    await expect(orchestrator.delegate(runtime, { agentId: "coder", objective: "too many", budget: { maxModelCalls: 100 } })).rejects.toThrow("child_budget_exceeded");
    expect(() => runtime.budget.consume("toolCalls", 101)).toThrow("budget_exceeded");
    const forged = new AgentRuntime(agents.get("planner")!, "s", root.id, jsonProvider(() => ({ kind: "result", summary: "ok" })), ["memory:read", "state:write"]);
    await expect(orchestrator.delegate(forged, { agentId: "coder", objective: "forged authority" })).rejects.toThrow("permission_inheritance_violation");
  });

  it("inherits omitted child budget limits instead of applying larger schema defaults", () => {
    const ledger = new AgentBudgetLedger(agentBudgetSchema.parse({ maxModelCalls: 1, maxToolCalls: 2, maxPtcExecutions: 3, maxInvocations: 4, maxChildTasks: 1 }));
    const child = ledger.reserveChild();
    expect(child.maxModelCalls).toBe(1);
    expect(child.maxToolCalls).toBe(2);
    expect(child.maxPtcExecutions).toBe(3);
    expect(child.maxInvocations).toBe(4);
  });

  it("rejects dependency cycles and blocks fail-fast dependents", async () => {
    const agents = registry();
    const store = new InMemoryAgentTaskStore();
    const manager = new TaskManager(store, agents, 3);
    const a = await manager.create({ sessionId: "s", createdBy: "host", assignedAgentId: "researcher", objective: "a", input: {}, outputReferences: [], memoryReferences: [], artifactReferences: [], dependencyIds: [], failurePolicy: "fail-fast", maxAttempts: 1, metadata: {} });
    const b = await manager.create({ sessionId: "s", createdBy: "host", assignedAgentId: "researcher", objective: "b", input: {}, outputReferences: [], memoryReferences: [], artifactReferences: [], dependencyIds: [a.id], failurePolicy: "fail-fast", maxAttempts: 1, metadata: {} });
    await expect(manager.create({ sessionId: "s", createdBy: "host", assignedAgentId: "researcher", objective: "cycle", input: {}, outputReferences: [], memoryReferences: [], artifactReferences: [], dependencyIds: [b.id, a.id], failurePolicy: "fail-fast", maxAttempts: 1, metadata: {} })).rejects.toThrow("task_dependency_cycle");
    await manager.start(a.id);
    await manager.fail(a.id);
    expect((await manager.start(b.id)).status).toBe("blocked");
  });

  it("records auditable handoffs and cascades cancellation", async () => {
    const agents = registry();
    const events = new EventBus();
    const handoffs: string[] = [];
    events.on("agent.handoff", (event) => { handoffs.push(event.messageId); });
    const orchestrator = new MultiAgentOrchestrator({ registry: agents, providers: {}, hostPermissions: ["memory:read", "history:read"] , events });
    const root = await orchestrator.createRoot({ sessionId: "s", objective: "cancel", agentId: "planner" });
    const runtime = new AgentRuntime(agents.get("planner")!, "s", root.id, jsonProvider(() => ({ kind: "result", summary: "ok" })), ["memory:read"]);
    const child = await orchestrator.delegate(runtime, { agentId: "researcher", objective: "child" });
    await orchestrator.handoff(runtime, "researcher", child, { summary: "bounded" });
    expect(handoffs).toHaveLength(1);
    expect((await orchestrator.cancel(root.id)).map((task) => task.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("keeps role-aware retrieval and tool exposure scoped to each definition", () => {
    const agents = registry();
    const researcher = agents.get("researcher")!;
    expect(memoryQueryForAgent("researcher", { query: "database", limit: 10 }).types).toEqual(["semantic", "episodic", "entity"]);
    expect(agentCanUseTool(researcher, "memory.search")).toBe(true);
    expect(agentCanUseTool(researcher, "state.patch")).toBe(false);
    expect(agentCanUseTool(agents.get("reviewer")!, "artifact.query")).toBe(true);
  });

  it("keeps private artifacts private while allowing explicit task/session sharing", () => {
    const workspace = new AgentArtifactWorkspace();
    workspace.register({ handleId: "artifact://private", ownerAgentId: "researcher", taskId: "task-a", sessionId: "s", visibility: "private" });
    workspace.register({ handleId: "artifact://task", ownerAgentId: "researcher", taskId: "task-a", sessionId: "s", visibility: "task" });
    workspace.register({ handleId: "artifact://shared", ownerAgentId: "researcher", taskId: "task-a", sessionId: "s", visibility: "shared" });
    expect(workspace.readable(["artifact://private", "artifact://task", "artifact://shared"], "coder", "task-a", "s")).toEqual(["artifact://task", "artifact://shared"]);
  });

  it("routes agent memory proposals through the provisional Hidden-Agent pipeline", async () => {
    const agents = registry();
    let submitted: unknown;
    const orchestrator = new MultiAgentOrchestrator({ registry: agents, providers: {}, submitMemoryCandidate: async (request) => { submitted = request; return "job-1"; } });
    const root = await orchestrator.createRoot({ sessionId: "s", objective: "remember", agentId: "researcher" });
    const runtime = new AgentRuntime(agents.get("researcher")!, "s", root.id, jsonProvider(() => ({ kind: "result", summary: "ok" })), ["memory:read"]);
    await orchestrator.submitMemoryCandidate(runtime, { content: "possible fact", type: "semantic", importance: 0.4, confidence: 0.4, sourceType: "explicit_user_statement", sourceReferences: [{ sessionId: "s", messageId: "00000000-0000-4000-8000-000000000001" }] });
    expect(submitted).toMatchObject({ sessionId: "s", candidate: { sourceType: "assistant_inference", status: "provisional" } });
  });

  it("runs a bounded coder-reviewer revision loop", async () => {
    const agents = registry();
    let reviews = 0;
    const planner = jsonProvider((request) => request.input.includes("review\n") ? (reviews += 1, reviews === 1 ? { kind: "review", decision: "reject", summary: "fix", issues: ["missing test"] } : { kind: "review", decision: "approve", summary: "approved" }) : ({ kind: "plan", summary: "code and review", tasks: [
      { agentId: "coder", objective: "implement", dependencies: [] },
      { agentId: "reviewer", objective: "review", dependencies: [0], input: { reviewTargetIndex: 0 } },
    ] }));
    const coder = jsonProvider(() => ({ kind: "result", summary: "code" }));
    const orchestrator = new MultiAgentOrchestrator({ registry: agents, providers: { reasoning: planner, coding: coder }, hostPermissions: ["artifact:read", "artifact:write", "state:read", "state:write", "memory:read", "history:read", "tools:read", "tool:execute"], maxReviewIterations: 3 });
    const root = await orchestrator.createRoot({ sessionId: "s", objective: "reviewed change", agentId: "planner" });
    const result = await orchestrator.run(root.id);
    expect(result.status).toBe("completed");
    expect(reviews).toBeGreaterThanOrEqual(1);
  });
});
