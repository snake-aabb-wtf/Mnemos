import { describe, expect, it } from "vitest";
import { AgentRegistry, InMemoryAgentTaskStore, MockModelProvider, MultiAgentOrchestrator, createBuiltinAgentDefinitions } from "./index.js";

function setup() {
  const registry = new AgentRegistry();
  for (const definition of createBuiltinAgentDefinitions()) registry.register(definition);
  const planner = new MockModelProvider((request) => ({ content: JSON.stringify(request.input.includes("plan-marker") ? { kind: "plan", summary: "bounded plan", tasks: [
    { agentId: "researcher", objective: "research one", dependencies: [] },
    { agentId: "researcher", objective: "research two", dependencies: [] },
    { agentId: "coder", objective: "implement", dependencies: [0, 1] },
  ] } : { kind: "result", summary: "complete" }) }));
  const researcher = new MockModelProvider(() => ({ content: JSON.stringify({ kind: "result", summary: "evidence", memoryRefs: [] }) }));
  const coder = new MockModelProvider(() => ({ content: JSON.stringify({ kind: "result", summary: "implementation", artifactRefs: [] }) }));
  return new MultiAgentOrchestrator({ registry, taskStore: new InMemoryAgentTaskStore(), providers: { reasoning: planner, cheap: researcher, coding: coder }, hostPermissions: ["memory:read", "history:read", "artifact:read", "artifact:write", "tools:read", "tool:execute", "state:read", "state:write"], maxConcurrentAgents: 4, maxConcurrentAgentsPerSession: 4 });
}

describe("Phase 14 multi-agent evaluation", () => {
  it("executes deterministic planning, delegation, dependency, handoff and isolation workloads", async () => {
    const orchestrator = setup();
    const roots = [];
    for (let index = 0; index < 20; index += 1) roots.push(await orchestrator.createRoot({ sessionId: `session-${index % 4}`, objective: `plan-marker-${index}`, agentId: "planner" }));
    const results = await Promise.all(roots.map((root) => orchestrator.run(root.id)));
    const diagnostics = await orchestrator.diagnostics();
    const completedTasks = results.flatMap((result) => result.tasks).filter((task) => task.status === "completed").length;
    console.log(`phase14 agent metrics ${JSON.stringify({ roots: results.length, completedTasks, registeredAgents: diagnostics.registeredAgents, handoffs: diagnostics.handoffCount })}`);
    expect(results.every((result) => result.status === "completed")).toBe(true);
    expect(completedTasks).toBeGreaterThanOrEqual(80);
    expect(diagnostics.activeAgents).toBe(0);
  }, 60_000);
});
