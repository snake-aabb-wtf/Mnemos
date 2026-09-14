import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  ContextManager,
  contextModelInstructions,
  EventBus,
  Harness,
  MockModelProvider,
  ToolDispatcher,
  ToolDiscoveryIndex,
  ToolDiscoveryRuntime,
  ToolRegistry,
  defineTool,
  registerToolDiscoveryTools,
  type HarnessEventMap,
  type HistoryMessage,
  type HistoryStore,
  type StateStore,
} from "./index.js";

class MemoryHistory implements HistoryStore {
  private readonly entries: HistoryMessage[] = [];
  private sequence = 0;
  async append(message: Omit<HistoryMessage, "id" | "createdAt">): Promise<HistoryMessage> {
    const entry = { ...message, id: `00000000-0000-4000-8000-${String(++this.sequence).padStart(12, "0")}`, createdAt: new Date(0).toISOString() };
    this.entries.push(entry);
    return entry;
  }
  async get(sessionId: string, messageId: string): Promise<HistoryMessage | undefined> { return this.entries.find((entry) => entry.sessionId === sessionId && entry.id === messageId); }
  async list(sessionId: string): Promise<HistoryMessage[]> { return this.entries.filter((entry) => entry.sessionId === sessionId); }
}

class MemoryState implements StateStore {
  private readonly values = new Map<string, Record<string, unknown>>();
  async get<T extends Record<string, unknown>>(sessionId: string): Promise<T | undefined> { return this.values.get(sessionId) as T | undefined; }
  async set<T extends Record<string, unknown>>(sessionId: string, state: T): Promise<T> { this.values.set(sessionId, state); return state; }
  async patch<T extends Record<string, unknown>>(sessionId: string, patch: Partial<T>): Promise<T> { return this.set(sessionId, { ...(await this.get<T>(sessionId) ?? {}), ...patch } as T); }
}

function fakeTool(name: string, description: string, tags: readonly string[] = ["search"]): ReturnType<typeof defineTool> {
  return defineTool({
    name, description, shortSummary: description.slice(0, 60), tags, capabilities: tags,
    inputSchema: z.object({ query: z.string().optional() }).strict(), outputSchema: z.object({ ok: z.boolean() }).strict(),
    requiredPermissions: ["memory:read"], sideEffect: "read", concurrencySafe: true,
    async execute() { return { ok: true }; },
  });
}

describe("Phase 9 dynamic tool discovery", () => {
  it("ranks a 1000-tool lexical catalog, filters metadata, and tracks registry mutations", () => {
    const registry = new ToolRegistry();
    for (let index = 0; index < 1_000; index += 1) {
      const name = `catalog.tool-${String(index).padStart(4, "0")}`;
      registry.register(fakeTool(name, index === 731 ? "Search production database context" : `Synthetic catalog entry ${index}`, index === 731 ? ["database", "search"] : ["synthetic"]));
    }
    const discovery = new ToolDiscoveryIndex(registry);
    const result = discovery.search({ query: "production database", limit: 5 }, ["memory:read"]);
    expect(result[0]?.name).toBe("catalog.tool-0731");
    expect(result).toHaveLength(1);
    const evaluation = ["production database", "synthetic catalog entry 12", "catalog.tool-0999"];
    const topK = 5;
    const rankings = evaluation.map((query) => discoveryForEvaluation(query, registry, topK));
    const hitAtK = rankings.filter((rank) => rank > 0).length / evaluation.length;
    const recallAtK = hitAtK;
    const mrr = rankings.reduce((sum, rank) => sum + (rank === 0 ? 0 : 1 / rank), 0) / evaluation.length;
    expect({ hitAtK, recallAtK, mrr }).toEqual({ hitAtK: 1, recallAtK: 1, mrr: 1 });
    const oldHash = discovery.get("catalog.tool-0731")?.schemaHash;
    registry.update("catalog.tool-0731", fakeTool("catalog.tool-0731", "Updated production database context", ["database", "updated"]));
    expect(discovery.get("catalog.tool-0731")?.schemaHash).not.toBe(oldHash);
    expect(registry.unregister("catalog.tool-0731")).toBe(true);
    expect(discovery.get("catalog.tool-0731")).toBeUndefined();
    discovery.rebuild();
    expect(discovery.search({ query: "production database", limit: 5 }, ["memory:read"])).toHaveLength(0);
    discovery.dispose();

  });

  it("loads only described tools, enforces schema budgets, and preserves permission visibility", async () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool("memory.search", "Search memories"));
    registry.register(defineTool({
      ...fakeTool("secret.delete", "Delete private records", ["destructive"]), requiredPermissions: ["memory:delete"], sideEffect: "destructive" as const,
    }));
    const events = new EventBus<HarnessEventMap>();
    const seen: string[] = [];
    events.on("tool.loaded", ({ toolNames }) => { seen.push(...toolNames); });
    const runtime = new ToolDiscoveryRuntime({ registry, policy: { coreToolNames: ["memory.search"], maxLoadedDynamicTools: 1, toolSchemaTokenBudget: 80 }, events });
    const search = runtime.search({ query: "delete", limit: 5 }, ["memory:read"]);
    expect(search.candidates[0]).toMatchObject({ name: "secret.delete", available: false, unavailableReason: "permission_denied" });
    const described = runtime.describe("s", { names: ["secret.delete", "memory.search"] }, ["memory:read"]);
    expect(described.tools.find((tool) => tool.name === "secret.delete")).toMatchObject({ available: false, error: "permission_denied" });
    expect(runtime.snapshot("s", ["memory:read"]).names).toEqual(["memory.search"]);
    await runtime.emitDescribe("s", "agent", ["secret.delete", "memory.search"], described, 1);
    expect(seen).toEqual(["memory.search"]);
  });

  it("performs native search → describe → load → call without exposing the full registry", async () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool("context.inspect", "Inspect current context", ["context"]));
    registry.register(fakeTool("reports.fetch", "Fetch a report by query", ["report", "search"]));
    const discovery = new ToolDiscoveryRuntime({ registry, policy: { coreToolNames: ["tools.search", "tools.describe", "context.inspect"], maxLoadedDynamicTools: 4 } });
    registerToolDiscoveryTools(registry, discovery);
    const dispatcher = new ToolDispatcher({ registry });
    const history = new MemoryHistory();
    const toolsSeen: string[][] = [];
    const schemaTokensSeen: number[] = [];
    let round = 0;
    const provider = new MockModelProvider(({ tools, context }) => {
      round += 1;
      toolsSeen.push((tools ?? []).map((tool) => tool.name));
      schemaTokensSeen.push(context.stats.toolSchemaTokens);
      if (round === 1) return { kind: "tool-calls", toolCalls: [{ id: "s", name: "tools.search", arguments: { query: "report" } }] };
      if (round === 2) return { kind: "tool-calls", toolCalls: [{ id: "d", name: "tools.describe", arguments: { names: ["reports.fetch"] } }] };
      if (round === 3) return { kind: "tool-calls", toolCalls: [{ id: "f", name: "reports.fetch", arguments: { query: "latest" } }] };
      return { content: "done" };
    });
    const harness = new Harness({ history, state: new MemoryState(), provider, context: new ContextManager(), toolRuntime: {
      registry, dispatcher, discovery, grantedPermissions: ["tools:read", "memory:read"], executionMode: "native",
    } });
    await harness.send("s", "find a report");
    expect(toolsSeen[0]).toEqual(["context.inspect", "tools.describe", "tools.search"]);
    expect(toolsSeen[1]).toEqual(["context.inspect", "tools.describe", "tools.search"]);
    expect(toolsSeen[2]).toContain("reports.fetch");
    expect(toolsSeen[2]).not.toContain("run_code");
    const fullSchemaTokens = registry.nativeDeclarations().reduce((sum, declaration) => sum + Math.ceil(Buffer.byteLength(JSON.stringify(declaration)) / 4), 0)
      + contextModelInstructions().reduce((sum, instruction) => sum + Math.ceil(Buffer.byteLength(instruction) / 4), 0);
    expect(schemaTokensSeen[0]).toBeLessThan(fullSchemaTokens);
  });

  it("keeps a request catalog gate in Dispatcher and exposes a filtered PTC SDK", async () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool("memory.search", "Search memory"));
    registry.register(fakeTool("artifact.query", "Query artifacts", ["artifact", "search"]));
    const dispatcher = new ToolDispatcher({ registry });
    const denied = await dispatcher.dispatch({ id: "x", name: "artifact.query", arguments: {} }, { sessionId: "s", agentId: "a", principal: "p", grantedPermissions: ["memory:read"], allowedToolNames: ["memory.search"] });
    expect(denied).toMatchObject({ status: "error", error: { code: "tool_not_found" } });
    const { PtcSdkGenerator } = await import("./ptc.js");
    const sdk = new PtcSdkGenerator(registry).describe(["memory.search"]);
    expect(sdk.tools.map((tool) => tool.name)).toEqual(["memory.search"]);
    expect(sdk.declarations).not.toContain("artifact");
  });
});

function discoveryForEvaluation(query: string, registry: ToolRegistry, topK: number): number {
  const index = new ToolDiscoveryIndex(registry);
  const position = index.search({ query, limit: topK }, ["memory:read"]).findIndex((candidate) => candidate.name.toLocaleLowerCase() === query.toLocaleLowerCase() || candidate.description.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  index.dispose();
  return position < 0 ? 0 : position + 1;
}
