import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactSpillService,
  ContextManager,
  EventBus,
  Harness,
  InMemoryToolAuditStore,
  LexicalMemoryRetriever,
  MemoryConsolidationService,
  MemoryService,
  MockModelProvider,
  ToolDispatcher,
  ToolRegistry,
  defineTool,
  registerCognitiveTools,
  type HiddenAgent,
  type ToolDispatchContext,
} from "@mnemos/core";
import { SqliteArtifactStore } from "./artifact.js";
import { SqliteConsolidationJobStore } from "./consolidation.js";
import { SqliteMemoryStore } from "./memory.js";
import { SqliteHistoryStore, SqliteStateStore } from "./sqlite.js";

const directories: string[] = [];
const closers: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const closer of closers.splice(0)) closer.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const hidden: HiddenAgent = {
  async extract() { return { candidates: [] }; },
  async reconcile() { return { decisions: [] }; },
};

async function runtime(contextManager = new ContextManager()) {
  const directory = await mkdtemp(join(tmpdir(), "mnemos-tools-"));
  directories.push(directory);
  const databasePath = join(directory, "runtime.sqlite");
  const history = new SqliteHistoryStore(databasePath);
  const state = new SqliteStateStore(databasePath);
  const memoryStore = new SqliteMemoryStore(databasePath);
  const artifacts = new SqliteArtifactStore({ databasePath, storageDirectory: join(directory, "artifacts") });
  const jobs = new SqliteConsolidationJobStore(databasePath);
  closers.push(history, state, memoryStore, artifacts, jobs);
  const memories = new MemoryService(memoryStore, history);
  const retriever = new LexicalMemoryRetriever(memories);
  const consolidation = new MemoryConsolidationService({ history, memories, jobs, hiddenAgent: hidden, retriever });
  const registry = new ToolRegistry();
  registerCognitiveTools(registry, { memories, retriever, history, context: contextManager, state, artifacts, consolidation });
  const audit = new InMemoryToolAuditStore();
  const events: string[] = [];
  const eventBus = new EventBus();
  eventBus.on("tool.called", ({ toolName }) => { events.push(`called:${toolName}`); });
  eventBus.on("tool.completed", ({ toolName }) => { events.push(`completed:${toolName}`); });
  eventBus.on("tool.failed", ({ errorCode }) => { events.push(`failed:${errorCode}`); });
  eventBus.on("tool.denied", ({ toolName }) => { events.push(`denied:${toolName}`); });
  eventBus.on("tool.output.spilled", ({ toolName }) => { events.push(`spilled:${toolName}`); });
  const spill = new ArtifactSpillService(artifacts, { maxInlineBytes: 1_024, spillThresholdBytes: 2_048 });
  const dispatcher = new ToolDispatcher({
    registry,
    artifactSpill: spill,
    events: eventBus,
    audit,
    outputPolicy: { maxInlineBytes: 1_024, spillThresholdBytes: 2_048, maxModelVisibleBytes: 4_096 },
    defaultToolTimeoutMs: 100,
  });
  const context: ToolDispatchContext = {
    sessionId: "session-a",
    agentId: "visible-agent",
    principal: "test-visible-agent",
    grantedPermissions: [
      "memory:read", "memory:write", "history:read", "context:read", "context:write",
      "state:read", "artifact:read", "artifact:write",
    ],
  };
  return { directory, history, state, memoryStore, artifacts, jobs, memories, retriever, consolidation, registry, dispatcher, spill, audit, eventBus, events, context, contextManager };
}

async function currentDatabaseMemory(app: Awaited<ReturnType<typeof runtime>>) {
  const source = await app.history.append({ sessionId: "session-a", role: "user", content: "The current production database is PostgreSQL." });
  return app.memories.create({
    type: "decision",
    content: "The current production database is PostgreSQL.",
    sourceReferences: [{ sessionId: "session-a", messageId: source.id }],
    importance: 0.9,
    confidence: 1,
    sourceType: "explicit_user_statement",
    status: "active",
    entities: ["database", "postgresql"],
    tags: ["architecture"],
  });
}

describe("Phase 7 Tool Runtime", () => {
  it("registers namespaced cognitive tools, exports JSON Schema, and rejects duplicate definitions", async () => {
    const app = await runtime();
    expect(app.registry.list().map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "memory.search", "memory.remember", "history.search", "context.inspect", "state.patch", "artifact.read", "artifact.delete",
    ]));
    const memorySearch = app.registry.list().find((tool) => tool.name === "memory.search");
    expect(memorySearch?.inputSchema).toMatchObject({ type: "object", properties: { query: { type: "string" } } });
    expect(app.registry.nativeDeclarations().find((tool) => tool.name === "memory.search")?.description).toContain("memories");
    expect(() => app.registry.register(defineTool({
      name: "memory.search", description: "duplicate", inputSchema: app.registry.get("memory.search")!.inputSchema, requiredPermissions: ["memory:read"],
      sideEffect: "read", concurrencySafe: true, async execute() { return {}; },
    }))).toThrow(/already registered/);
    expect(() => app.registry.get("not-a-tool")).toThrow(/namespace/);
  });

  it("enforces permission, lookup, and input validation before cognitive execution and records compact audit/events", async () => {
    const app = await runtime();
    await currentDatabaseMemory(app);
    const allowed = await app.dispatcher.dispatch({ id: "read-1", name: "memory.search", arguments: { query: "current database" } }, app.context);
    expect(allowed).toMatchObject({ status: "success", output: { kind: "inline" } });
    const denied = await app.dispatcher.dispatch({ id: "write-1", name: "state.patch", arguments: { patch: { task: "unsafe" } } }, app.context);
    expect(denied).toMatchObject({ status: "error", error: { code: "permission_denied" } });
    const destructive = await app.dispatcher.dispatch({ id: "delete-1", name: "artifact.delete", arguments: { id: "artifact://00000000-0000-4000-8000-000000000000" } }, app.context);
    expect(destructive).toMatchObject({ status: "error", error: { code: "permission_denied" } });
    const unknown = await app.dispatcher.dispatch({ id: "unknown-1", name: "memory.missing", arguments: {} }, app.context);
    expect(unknown).toMatchObject({ status: "error", error: { code: "tool_not_found" } });
    const malformed = await app.dispatcher.dispatch({ id: "bad-1", name: "memory.search", arguments: { limit: 3 } }, app.context);
    expect(malformed).toMatchObject({ status: "error", error: { code: "invalid_arguments" } });
    expect(await app.audit.list({ sessionId: "session-a" })).toHaveLength(5);
    expect(app.events).toEqual(expect.arrayContaining(["called:memory.search", "completed:memory.search", "denied:state.patch", "failed:tool_not_found"]));
  });

  it("routes Context mutation through the configured pin budget", async () => {
    const app = await runtime(new ContextManager(undefined, { pinnedTokenBudget: 2 }));
    const context = { ...app.context, grantedPermissions: [...app.context.grantedPermissions, "context:write"] as const };
    expect(await app.dispatcher.dispatch({ id: "pin-one", name: "context.pin", arguments: { id: "goal", content: "abcd" } }, context)).toMatchObject({ status: "success" });
    expect(await app.dispatcher.dispatch({ id: "pin-two", name: "context.pin", arguments: { id: "notes", content: "abcdefgh" } }, context)).toMatchObject({
      status: "error", error: { code: "execution_failed" },
    });
    expect(app.contextManager.listPins("session-a").map((pin) => pin.id)).toEqual(["goal"]);
  });

  it("normalizes small outputs inline and spills a 10MB+ output through the actual Artifact Store", async () => {
    const app = await runtime();
    const inputSchema = app.registry.get("memory.search")!.inputSchema;
    app.registry.register(defineTool({
      name: "test.small-output", description: "Returns a small structured output.", inputSchema,
      requiredPermissions: ["state:read"], sideEffect: "none", concurrencySafe: true,
      async execute() { return { value: "small" }; },
    }));
    app.registry.register(defineTool({
      name: "test.giant-output", description: "Returns a deliberately large text output.", inputSchema,
      requiredPermissions: ["state:read"], sideEffect: "none", concurrencySafe: true,
      async execute() { return "x".repeat(10 * 1024 * 1024 + 1); },
    }));
    const small = await app.dispatcher.dispatch({ id: "small", name: "test.small-output", arguments: { query: "unused" } }, app.context);
    expect(small).toMatchObject({ status: "success", output: { kind: "inline", value: { value: "small" } } });
    const giant = await app.dispatcher.dispatch({ id: "giant", name: "test.giant-output", arguments: { query: "unused" } }, app.context);
    expect(giant.status).toBe("success");
    if (giant.status !== "success" || giant.output.kind !== "artifact") throw new Error("expected artifact-spilled tool output");
    expect((await app.artifacts.get(giant.output.handle.id))?.sizeBytes).toBeGreaterThan(10 * 1024 * 1024);
    expect(app.events).toContain("spilled:test.giant-output");

    let round = 0;
    let continuationToolTokens = 0;
    const harness = new Harness({
      history: app.history,
      state: app.state,
      context: new ContextManager(),
      provider: new MockModelProvider(({ context }) => {
        round += 1;
        if (round === 1) return { kind: "tool-calls", toolCalls: [{ id: "giant-loop", name: "test.giant-output", arguments: { query: "unused" } }] };
        continuationToolTokens = context.stats.toolResultTokens;
        return { content: "Large output was stored as an Artifact." };
      }),
      toolRuntime: { registry: app.registry, dispatcher: app.dispatcher, grantedPermissions: app.context.grantedPermissions },
      logger: { debug: () => undefined } as never,
    });
    await harness.send("session-a", "Generate a large report.");
    const toolMessage = (await app.history.list("session-a")).filter((message) => message.metadata?.toolCallId === "giant-loop").at(-1);
    expect(toolMessage?.content).toContain('"kind":"artifact"');
    expect(toolMessage?.content.length).toBeLessThan(4_096);
    expect(continuationToolTokens).toBeLessThan(1_024);
  }, 30_000);

  it("times out cooperatively and isolates execution errors without breaking later calls", async () => {
    const app = await runtime();
    const inputSchema = app.registry.get("memory.search")!.inputSchema;
    app.registry.register(defineTool({
      name: "test.timeout", description: "Waits past its local timeout.", inputSchema,
      requiredPermissions: ["state:read"], sideEffect: "none", concurrencySafe: true, timeoutMs: 5,
      async execute() { await new Promise((resolve) => setTimeout(resolve, 40)); return { late: true }; },
    }));
    app.registry.register(defineTool({
      name: "test.throw", description: "Throws a private internal error.", inputSchema,
      requiredPermissions: ["state:read"], sideEffect: "none", concurrencySafe: true,
      async execute() { throw new Error("private stack detail"); },
    }));
    app.registry.register(defineTool({
      name: "test.invalid-output", description: "Violates its declared output schema.", inputSchema, outputSchema: inputSchema,
      requiredPermissions: ["state:read"], sideEffect: "none", concurrencySafe: true,
      async execute() { return { unsupported: true }; },
    }));
    expect(await app.dispatcher.dispatch({ id: "timeout", name: "test.timeout", arguments: { query: "unused" } }, app.context)).toMatchObject({
      status: "error", error: { code: "timeout", message: "Tool execution timed out." },
    });
    expect(await app.dispatcher.dispatch({ id: "throws", name: "test.throw", arguments: { query: "unused" } }, app.context)).toMatchObject({
      status: "error", error: { code: "execution_failed", message: "Tool test.throw could not complete." },
    });
    expect(await app.dispatcher.dispatch({ id: "invalid-output", name: "test.invalid-output", arguments: { query: "unused" } }, app.context)).toMatchObject({
      status: "error", error: { code: "invalid_output" },
    });
    expect(await app.dispatcher.dispatch({ id: "after", name: "state.get", arguments: {} }, app.context)).toMatchObject({ status: "success" });

    let round = 0;
    const harness = new Harness({
      history: app.history, state: app.state, context: new ContextManager(),
      provider: new MockModelProvider(() => {
        round += 1;
        return round === 1
          ? { kind: "tool-calls", toolCalls: [{ id: "throw-loop", name: "test.throw", arguments: { query: "unused" } }] }
          : { content: "Recovered after the tool error." };
      }),
      toolRuntime: { registry: app.registry, dispatcher: app.dispatcher, grantedPermissions: app.context.grantedPermissions },
      logger: { debug: () => undefined } as never,
    });
    await expect(harness.send("session-a", "Try the failing tool.")).resolves.toMatchObject({ content: "Recovered after the tool error." });
    expect((await app.history.list("session-a")).find((message) => message.role === "tool" && message.metadata?.toolCallId === "throw-loop")?.content).toContain("execution_failed");
    await expect(harness.send("session-a", "Can you continue?")).resolves.toMatchObject({ content: "Recovered after the tool error." });
  });

  it("adapts artifact query/read safely: snippets stay inline while a bounded huge read is spilled", async () => {
    const app = await runtime();
    const record = await app.artifacts.create({
      sessionId: "session-a", type: "report", mimeType: "text/plain", content: `${"a".repeat(1024 * 1024)}\nneedle in report`,
    });
    const query = await app.dispatcher.dispatch({ id: "query", name: "artifact.query", arguments: { id: record.id, options: { query: "needle" } } }, app.context);
    expect(query).toMatchObject({ status: "success", output: { kind: "inline" } });
    const read = await app.dispatcher.dispatch({ id: "read", name: "artifact.read", arguments: { id: record.id } }, app.context);
    expect(read.status).toBe("success");
    if (read.status !== "success") throw new Error("expected read result");
    expect(read.output.kind).toBe("artifact");
    expect(read.output.serializedBytes).toBeGreaterThan(4_096);
    const binary = await app.artifacts.create({
      sessionId: "session-a", type: "binary", mimeType: "application/octet-stream", content: new Uint8Array([0, 1, 2]),
    });
    const binaryRead = await app.dispatcher.dispatch({ id: "binary-read", name: "artifact.read", arguments: { id: binary.id } }, app.context);
    expect(binaryRead).toMatchObject({ status: "success", output: { kind: "artifact" } });
  });

  it("runs User → memory.search → Dispatcher → Tool History → final Visible Agent answer with schema and result accounting", async () => {
    const app = await runtime();
    await currentDatabaseMemory(app);
    const visibleContexts: Array<{ schemaTokens: number; toolResultTokens: number; rawTokens: number }> = [];
    let calls = 0;
    const provider = new MockModelProvider(({ context, tools }) => {
      visibleContexts.push({ schemaTokens: context.stats.toolSchemaTokens, toolResultTokens: context.stats.toolResultTokens, rawTokens: context.stats.recentRawTokens });
      expect(tools?.some((tool) => tool.name === "memory.search")).toBe(true);
      calls += 1;
      return calls === 1
        ? { kind: "tool-calls" as const, toolCalls: [{ id: "database-search", name: "memory.search", arguments: { query: "current database" } }] }
        : { content: "当前使用 PostgreSQL。" };
    });
    const harness = new Harness({
      history: app.history,
      state: app.state,
      context: new ContextManager(),
      provider,
      toolRuntime: { registry: app.registry, dispatcher: app.dispatcher, grantedPermissions: app.context.grantedPermissions, maxToolIterations: 2 },
      logger: { debug: () => undefined } as never,
    });
    const answer = await harness.send("session-a", "我们现在使用什么数据库？");
    expect(answer.content).toBe("当前使用 PostgreSQL。");
    const history = await app.history.list("session-a");
    expect(history.slice(-4).map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(history.at(-3)?.metadata).toMatchObject({ transactionId: "database-search", toolName: "memory.search" });
    expect(history.at(-2)?.content.length).toBeLessThan(4_096);
    expect(visibleContexts[0].schemaTokens).toBeGreaterThan(0);
    expect(visibleContexts[1].toolResultTokens).toBeGreaterThan(0);
  });

  it("enforces maxToolIterations before a model can loop indefinitely", async () => {
    const app = await runtime();
    const harness = new Harness({
      history: app.history, state: app.state, context: new ContextManager(),
      provider: new MockModelProvider(() => ({
        kind: "tool-calls", toolCalls: [{ id: "loop-call", name: "state.get", arguments: {} }],
      })),
      toolRuntime: { registry: app.registry, dispatcher: app.dispatcher, grantedPermissions: app.context.grantedPermissions, maxToolIterations: 1 },
      logger: { debug: () => undefined } as never,
    });
    await expect(harness.send("session-a", "Loop forever.")).resolves.toMatchObject({ content: "Tool iteration limit reached before a final response." });
    expect((await app.history.list("session-a")).filter((message) => message.role === "tool")).toHaveLength(1);
  });

  it("supports recall → source verification through the native tool loop and queues memory.remember instead of direct writes", async () => {
    const app = await runtime();
    const memory = await currentDatabaseMemory(app);
    let round = 0;
    const provider = new MockModelProvider(() => {
      round += 1;
      if (round === 1) return { kind: "tool-calls" as const, toolCalls: [{ id: "find", name: "memory.search", arguments: { query: "current database" } }] };
      if (round === 2) return { kind: "tool-calls" as const, toolCalls: [{ id: "source", name: "memory.source", arguments: { id: memory.id } }] };
      return { content: "确定：原始记录明确写着当前生产数据库是 PostgreSQL。" };
    });
    const harness = new Harness({
      history: app.history, state: app.state, context: new ContextManager(), provider,
      toolRuntime: {
        registry: app.registry, dispatcher: app.dispatcher,
        grantedPermissions: ["memory:read", "history:read", "memory:write", "state:read", "artifact:read", "artifact:write", "context:read", "context:write"],
      }, logger: { debug: () => undefined } as never,
    });
    await expect(harness.send("session-a", "你确定吗？原话是什么？")).resolves.toMatchObject({ content: expect.stringContaining("PostgreSQL") });
    expect((await app.history.list("session-a")).filter((message) => message.role === "tool").map((message) => message.metadata?.toolName)).toEqual(["memory.search", "memory.source"]);

    const source = await app.history.append({ sessionId: "session-a", role: "user", content: "Remember that I prefer compact replies." });
    const remembered = await app.dispatcher.dispatch({
      id: "remember", name: "memory.remember", arguments: {
        candidate: {
          content: "User prefers compact replies.", type: "preference", importance: 0.7, confidence: 1,
          sourceType: "explicit_user_statement", sourceReferences: [{ sessionId: "session-a", messageId: source.id }],
          entities: [], tags: ["style"], status: "active",
        },
      },
    }, { ...app.context, grantedPermissions: [...app.context.grantedPermissions, "memory:write"] });
    expect(remembered).toMatchObject({ status: "success", output: { kind: "inline" } });
    expect((await app.jobs.list()).at(-1)).toMatchObject({ origin: "visible-candidate" });
    expect((await app.memories.list()).map((entry) => entry.content)).not.toContain("User prefers compact replies.");
  });
});
