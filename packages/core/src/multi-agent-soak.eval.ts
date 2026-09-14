import { describe, expect, it } from "vitest";
import { AgentRegistry, InMemoryAgentTaskStore, MockModelProvider, MultiAgentOrchestrator, createBuiltinAgentDefinitions } from "./index.js";

describe("Phase 14 multi-agent soak", () => {
  it("runs 150 bounded roots and more than 1,000 deterministic agent invocations", async () => {
    const registry = new AgentRegistry();
    for (const definition of createBuiltinAgentDefinitions()) registry.register(definition);
    let invocations = 0;
    const planner = new MockModelProvider((request) => { invocations += 1; return { content: JSON.stringify(request.input.includes("soak-plan") ? { kind: "plan", summary: "soak", tasks: Array.from({ length: 5 }, (_, index) => ({ agentId: "researcher", objective: `child-${index}`, dependencies: [] })) } : { kind: "result", summary: "done" }) }; });
    const researcher = new MockModelProvider(() => { invocations += 1; return { content: JSON.stringify({ kind: "result", summary: "evidence" }) }; });
    const orchestrator = new MultiAgentOrchestrator({ registry, taskStore: new InMemoryAgentTaskStore(), providers: { reasoning: planner, cheap: researcher, coding: researcher }, hostPermissions: ["memory:read", "history:read", "artifact:read", "tools:read", "tool:execute"], maxConcurrentAgents: 8, maxConcurrentAgentsPerSession: 8 });
    const roots = [];
    for (let index = 0; index < 150; index += 1) roots.push(await orchestrator.createRoot({ sessionId: `soak-${index % 10}`, objective: `soak-plan-${index}`, agentId: "planner" }));
    const results = await Promise.all(roots.map((root) => orchestrator.run(root.id)));
    const diagnostics = await orchestrator.diagnostics();
    console.log(`phase14 agent soak ${JSON.stringify({ roots: roots.length, invocations, taskCounts: diagnostics.taskCounts, activeAgents: diagnostics.activeAgents })}`);
    expect(results.every((result) => result.status === "completed")).toBe(true);
    expect(invocations).toBeGreaterThanOrEqual(1_000);
    expect(diagnostics.activeAgents).toBe(0);
    expect(diagnostics.taskCounts.failed ?? 0).toBe(0);
  }, 120_000);
});
