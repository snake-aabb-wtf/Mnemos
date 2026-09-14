import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ArtifactSpillService,
  ContextManager,
  EventBus,
  Harness,
  InMemoryToolAuditStore,
  MockModelProvider,
  PTC_POLICY_VERSION,
  PtcRuntime,
  ToolDispatcher,
  ToolRegistry,
  defineTool,
  registerPtcTool,
  runCodeToolName,
  type PtcExecutionResult,
  type ToolPermission,
} from "@mnemos/core";
import { SqliteArtifactStore } from "./artifact.js";
import { SqliteHistoryStore, SqliteStateStore } from "./sqlite.js";

const directories: string[] = [];
const closers: Array<{ close(): void }> = [];
const querySchema = z.object({ query: z.string().min(1) }).strict();

afterEach(async () => {
  for (const closer of closers.splice(0)) closer.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function app() {
  const directory = await mkdtemp(join(tmpdir(), "mnemos-ptc-tests-"));
  directories.push(directory);
  const databasePath = join(directory, "runtime.sqlite");
  const history = new SqliteHistoryStore(databasePath);
  const state = new SqliteStateStore(databasePath);
  const artifacts = new SqliteArtifactStore({ databasePath, storageDirectory: join(directory, "artifacts") });
  closers.push(history, state, artifacts);
  const registry = new ToolRegistry();
  const audit = new InMemoryToolAuditStore();
  const events: string[] = [];
  const eventBus = new EventBus();
  eventBus.on("ptc.started", () => { events.push("started"); });
  eventBus.on("ptc.completed", () => { events.push("completed"); });
  eventBus.on("ptc.failed", ({ errorCode }) => { events.push("failed:" + errorCode); });
  const spill = new ArtifactSpillService(artifacts, { maxInlineBytes: 1_024, spillThresholdBytes: 2_048 });
  const dispatcher = new ToolDispatcher({
    registry,
    artifactSpill: spill,
    audit,
    events: eventBus,
    outputPolicy: { maxInlineBytes: 1_024, spillThresholdBytes: 2_048, maxModelVisibleBytes: 4_096 },
  });
  const context = {
    sessionId: "ptc-session",
    agentId: "visible-agent",
    principal: "ptc-test",
    grantedPermissions: ["state:read", "state:write", "tool:execute"] as const,
  };
  return { directory, history, state, artifacts, registry, audit, eventBus, events, spill, dispatcher, context };
}

function installPtc(
  runtime: Awaited<ReturnType<typeof app>>,
  policy: ConstructorParameters<typeof PtcRuntime>[0]["policy"] = {},
) {
  const ptc = new PtcRuntime({
    registry: runtime.registry,
    dispatcher: runtime.dispatcher,
    artifactSpill: runtime.spill,
    events: runtime.eventBus,
    policy,
  });
  registerPtcTool(runtime.registry, ptc);
  return ptc;
}

async function execute(
  runtime: Awaited<ReturnType<typeof app>>,
  code: string,
  permissions: readonly ToolPermission[] = runtime.context.grantedPermissions,
  language: "typescript" | "javascript" = "typescript",
): Promise<PtcExecutionResult> {
  const dispatched = await runtime.dispatcher.dispatch({
    id: "run-" + Math.random().toString(36).slice(2),
    name: runCodeToolName,
    arguments: { code, language },
  }, { ...runtime.context, grantedPermissions: permissions });
  expect(dispatched.status).toBe("success");
  if (dispatched.status !== "success" || dispatched.output.kind !== "inline") throw new Error("run_code did not return an inline structured result");
  return dispatched.output.value as PtcExecutionResult;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("Phase 8 Programmatic Tool Calling", () => {
  it("keeps a 100+ subcall workflow bounded and fully audited", async () => {
    const runtime = await app();
    runtime.registry.register(defineTool({
      name: "test.read", description: "A tiny deterministic read.", inputSchema: querySchema,
      requiredPermissions: ["state:read"], sideEffect: "read", concurrencySafe: true,
      async execute(input: { query: string }) { return { query: input.query }; },
    }));
    installPtc(runtime, { maxToolCalls: 200, maxConcurrentToolCalls: 8 });
    const result = await execute(runtime, "const values = []; for (let i = 0; i < 120; i++) values.push(await tools.test.read({ query: String(i) })); return values.length;");
    expect(result).toMatchObject({ status: "success", result: 120, stats: { toolCalls: 120 } });
    expect((await runtime.audit.list({ sessionId: "ptc-session", limit: 200 })).filter((entry) => entry.toolName === "test.read")).toHaveLength(120);
  }, 60_000);

  it("runs concurrency-safe reads in parallel, limits them, and applies a write barrier", async () => {
    const runtime = await app();
    let active = 0;
    let peak = 0;
    const timeline: string[] = [];
    const read = defineTool({
      name: "test.read", description: "A concurrency-safe read.", inputSchema: querySchema,
      requiredPermissions: ["state:read"], sideEffect: "read" as const, concurrencySafe: true,
      async execute(input: { query: string }) {
        active += 1;
        peak = Math.max(peak, active);
        timeline.push("read-start:" + input.query);
        await delay(25);
        timeline.push("read-end:" + input.query);
        active -= 1;
        return { query: input.query };
      },
    });
    const write = defineTool({
      name: "test.write", description: "A serialized write.", inputSchema: querySchema,
      requiredPermissions: ["state:write"], sideEffect: "write" as const, concurrencySafe: false,
      async execute(input: { query: string }) {
        timeline.push("write-start:" + input.query + ":active=" + String(active));
        await delay(10);
        timeline.push("write-end:" + input.query);
        return { query: input.query };
      },
    });
    runtime.registry.register(read);
    runtime.registry.register(write);
    installPtc(runtime, { maxConcurrentToolCalls: 2 });
    const result = await execute(runtime,
      "const early = Promise.all([tools.test.read({ query: 'a' }), tools.test.read({ query: 'b' })]);\n"
      + "const write = tools.test.write({ query: 'c' });\n"
      + "const later = tools.test.read({ query: 'd' });\n"
      + "return await Promise.all([early, write, later]);",
    );
    expect(result).toMatchObject({ status: "success", stats: { toolCalls: 4, peakConcurrency: 2 } });
    expect(peak).toBe(2);
    expect(timeline.indexOf("read-end:a")).toBeLessThan(timeline.findIndex((value) => value.startsWith("write-start")));
    expect(timeline.indexOf("read-end:b")).toBeLessThan(timeline.findIndex((value) => value.startsWith("write-start")));
    expect(timeline.find((value) => value.startsWith("write-start"))).toContain("active=0");
    expect(timeline.indexOf("write-end:c")).toBeLessThan(timeline.indexOf("read-start:d"));
    const audited = await runtime.audit.list({ sessionId: "ptc-session" });
    expect(audited).toHaveLength(5);
    expect(new Set(audited.map((entry) => entry.callId)).size).toBe(5);
  });

  it("enforces per-invocation tool quotas without corrupting the next isolated invocation", async () => {
    const runtime = await app();
    runtime.registry.register(defineTool({
      name: "test.read", description: "Read for quota tests.", inputSchema: querySchema,
      requiredPermissions: ["state:read"], sideEffect: "read", concurrencySafe: true,
      async execute(input: { query: string }) { return { query: input.query }; },
    }));
    installPtc(runtime, { maxToolCalls: 2 });
    const overQuota = await execute(runtime,
      "for (let index = 0; index < 1_000; index += 1) { try { await tools.test.read({ query: String(index) }); } catch {} } return true;",
    );
    expect(overQuota).toMatchObject({ status: "error", error: { code: "tool_call_quota_exceeded" }, stats: { toolCalls: 2 } });
    const recovered = await execute(runtime, "return await tools.test.read({ query: 'healthy' });");
    expect(recovered).toMatchObject({ status: "success", result: { query: "healthy" }, stats: { toolCalls: 1 } });
    expect(await runtime.audit.list({ sessionId: "ptc-session" })).toHaveLength(5);
  });

  it("exposes only run_code in ptc mode and accounts for its generated catalog instructions", async () => {
    const runtime = await app();
    runtime.registry.register(defineTool({
      name: "test.read", description: "Read exposed through PTC SDK.", inputSchema: querySchema,
      outputSchema: z.object({ query: z.string() }),
      requiredPermissions: ["state:read"], sideEffect: "read", concurrencySafe: true,
      async execute(input: { query: string }) { return { query: input.query }; },
    }));
    const ptc = installPtc(runtime);
    const visible = new Harness({
      history: runtime.history,
      state: runtime.state,
      context: new ContextManager(),
      provider: new MockModelProvider(({ tools, runtimeInstructions, context }) => {
        expect(tools?.map((tool) => tool.name)).toEqual([runCodeToolName]);
        expect(runtimeInstructions?.[0]).toBe(PTC_POLICY_VERSION);
        expect(runtimeInstructions?.join("\n")).toContain("readonly read");
        expect(runtimeInstructions?.join("\n")).toContain("Promise<{ \"query\": string }>");
        expect(context.stats.toolSchemaTokens).toBeGreaterThan(0);
        return { content: "PTC catalog is configured." };
      }),
      toolRuntime: {
        registry: runtime.registry, dispatcher: runtime.dispatcher, ptc,
        grantedPermissions: runtime.context.grantedPermissions, executionMode: "ptc",
      },
      logger: { debug: () => undefined } as never,
    });
    await expect(visible.send("ptc-mode-session", "Show available execution mode.")).resolves.toMatchObject({
      content: "PTC catalog is configured.",
    });
  });

  it("bounds SDK RPC argument payloads before they reach ToolDispatcher", async () => {
    const runtime = await app();
    let calls = 0;
    runtime.registry.register(defineTool({
      name: "test.read", description: "Read with bounded PTC input.", inputSchema: querySchema,
      requiredPermissions: ["state:read"], sideEffect: "read", concurrencySafe: true,
      async execute() { calls += 1; return { ok: true }; },
    }));
    installPtc(runtime, { maxToolArgumentBytes: 128 });
    const result = await execute(runtime,
      "try { await tools.test.read({ query: 'x'.repeat(1_024) }); } catch (error) { return { code: error.code }; }",
    );
    expect(result).toMatchObject({ status: "success", result: { code: "invalid_arguments" }, stats: { toolCalls: 0 } });
    expect(calls).toBe(0);
    expect(await runtime.audit.list({ sessionId: "ptc-session" })).toHaveLength(1);
  });

  it("keeps internal artifacts out of the program transport and spills large final results", async () => {
    const runtime = await app();
    runtime.registry.register(defineTool({
      name: "test.giant", description: "Returns a large read result.", inputSchema: querySchema,
      requiredPermissions: ["state:read"], sideEffect: "read", concurrencySafe: true,
      async execute() { return "g".repeat(16 * 1024); },
    }));
    installPtc(runtime, { maxReturnedBytes: 1_024, maxSandboxResultBytes: 512 * 1024 });
    const internalArtifact = await execute(runtime, "return await tools.test.giant({ query: 'artifact' });");
    expect(internalArtifact).toMatchObject({ status: "success", result: { id: expect.stringMatching(/^artifact:\/\//) } });
    const giantFinal = await execute(runtime, "return 'r'.repeat(64 * 1024);");
    expect(giantFinal).toMatchObject({
      status: "success",
      result: { id: expect.stringMatching(/^artifact:\/\//) },
      artifacts: [expect.objectContaining({ type: "ptc-result" })],
    });
    if (giantFinal.status !== "success") throw new Error("expected PTC artifact");
    const record = await runtime.artifacts.get(giantFinal.artifacts[0]!.id);
    expect(record?.sizeBytes).toBeGreaterThan(64 * 1024);
    expect((await runtime.audit.list({ sessionId: "ptc-session" })).find((entry) => entry.toolName === "test.giant")).toMatchObject({
      outputKind: "artifact",
    });
  });

  it("denies privilege escalation and rejects direct host, module, environment, and network capabilities", async () => {
    const runtime = await app();
    let secretCalls = 0;
    runtime.registry.register(defineTool({
      name: "test.secret", description: "A write requiring host permission.", inputSchema: querySchema,
      requiredPermissions: ["state:write"], sideEffect: "write", concurrencySafe: false,
      async execute() { secretCalls += 1; return { secret: true }; },
    }));
    installPtc(runtime);
    const noWritePermissions: readonly ToolPermission[] = ["state:read", "tool:execute"];
    const denied = await execute(runtime,
      "try { return await tools.test.secret({ query: 'x', agentId: 'root', grantedPermissions: ['state:write'] }); } catch (error) { return { code: error.code }; }",
      noWritePermissions,
    );
    expect(denied).toMatchObject({ status: "success", result: { code: "permission_denied" } });
    expect(secretCalls).toBe(0);
    expect((await runtime.audit.list({ sessionId: "ptc-session" })).find((entry) => entry.toolName === "test.secret")).toMatchObject({
      status: "denied",
    });
    for (const forbidden of [
      "return process.env;",
      "return require('node:fs');",
      "return await import('node:fs');",
      "return fetch('https://example.invalid');",
      "return new WebSocket('wss://example.invalid');",
      "return process.exit(1);",
    ]) {
      await expect(execute(runtime, forbidden, noWritePermissions)).resolves.toMatchObject({
        status: "error", error: { code: "source_invalid" },
      });
    }
    expect((await runtime.audit.list({ sessionId: "ptc-session" })).filter((entry) => entry.toolName === "test.secret")).toHaveLength(1);
  });

  it("hard-terminates loops, contains syntax and memory failures, and bounds debug logs", async () => {
    const runtime = await app();
    installPtc(runtime, { maxExecutionMs: 1_500, maxMemoryMb: 16, maxLogBytes: 128 });
    await expect(execute(runtime, "while (true) {}", runtime.context.grantedPermissions, "javascript")).resolves.toMatchObject({
      status: "error", error: { code: "execution_timeout" },
    });
    await expect(execute(runtime, "const = ;", runtime.context.grantedPermissions, "javascript")).resolves.toMatchObject({
      status: "error", error: { code: "execution_failed" },
    });
    for (const unsupportedReturn of [
      "return Symbol('not-json');",
      "return () => true;",
      "const value = {}; value.self = value; return value;",
    ]) {
      await expect(execute(runtime, unsupportedReturn)).resolves.toMatchObject({
        status: "error", error: { code: "serialization_failed" },
      });
    }
    const memory = await execute(runtime, "const values = new Array(50_000_000).fill({ value: 1 }); return values.length;", runtime.context.grantedPermissions, "javascript");
    expect(memory).toMatchObject({ status: "error", error: { code: "memory_limit" } });
    const logs = await execute(runtime, "console.log('x'.repeat(4_096)); return { ok: true };");
    expect(logs).toMatchObject({ status: "success", result: { ok: true }, stats: { logBytes: 128, logsTruncated: true } });
    expect(JSON.stringify(logs)).not.toContain("x".repeat(128));
    await expect(execute(runtime, "return { healthy: true };")).resolves.toMatchObject({ status: "success", result: { healthy: true } });
  }, 60_000);

  it("keeps 20 internal PTC calls out of visible history while Dispatcher audit remains complete", async () => {
    const runtime = await app();
    runtime.registry.register(defineTool({
      name: "test.search", description: "Returns a medium result for context accounting.", inputSchema: querySchema,
      requiredPermissions: ["state:read"], sideEffect: "read", concurrencySafe: true,
      async execute(input: { query: string }) { return { query: input.query, payload: "v".repeat(600) }; },
    }));
    const ptc = installPtc(runtime);
    let nativeRound = 0;
    let nativeToolTokens = 0;
    const native = new Harness({
      history: runtime.history,
      state: runtime.state,
      context: new ContextManager(),
      provider: new MockModelProvider(({ context, tools }) => {
        nativeRound += 1;
        expect(tools?.some((tool) => tool.name === runCodeToolName)).toBe(false);
        if (nativeRound <= 20) return { kind: "tool-calls", toolCalls: [{ id: "native-" + String(nativeRound), name: "test.search", arguments: { query: String(nativeRound) } }] };
        nativeToolTokens = context.stats.toolResultTokens;
        return { content: "native finished" };
      }),
      toolRuntime: {
        registry: runtime.registry, dispatcher: runtime.dispatcher,
        grantedPermissions: runtime.context.grantedPermissions, executionMode: "native", maxToolIterations: 25,
      },
      logger: { debug: () => undefined } as never,
    });
    await native.send("native-session", "Run native calls.");

    let ptcRound = 0;
    let ptcToolTokens = 0;
    const program = "const values = await Promise.all(Array.from({ length: 20 }, (_value, index) => tools.test.search({ query: String(index) }))); return values.slice(0, 2);";
    const ptcHarness = new Harness({
      history: runtime.history,
      state: runtime.state,
      context: new ContextManager(),
      provider: new MockModelProvider(({ context, tools, runtimeInstructions }) => {
        ptcRound += 1;
        expect(tools?.some((tool) => tool.name === runCodeToolName)).toBe(true);
        expect(runtimeInstructions?.[0]).toBe(PTC_POLICY_VERSION);
        if (ptcRound === 1) return { kind: "tool-calls", toolCalls: [{ id: "ptc-many", name: runCodeToolName, arguments: { code: program } }] };
        ptcToolTokens = context.stats.toolResultTokens;
        return { content: "ptc finished" };
      }),
      toolRuntime: {
        registry: runtime.registry, dispatcher: runtime.dispatcher, ptc,
        grantedPermissions: runtime.context.grantedPermissions, executionMode: "both", maxToolIterations: 2,
      },
      logger: { debug: () => undefined } as never,
    });
    await ptcHarness.send("ptc-session", "Run PTC calls.");
    const visibleHistory = await runtime.history.list("ptc-session");
    expect(visibleHistory.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(visibleHistory.filter((message) => message.metadata?.toolName === "test.search")).toHaveLength(0);
    expect(ptcToolTokens).toBeLessThan(nativeToolTokens);
    expect((await runtime.audit.list({ sessionId: "ptc-session" })).filter((entry) => entry.toolName === "test.search")).toHaveLength(20);
    expect((await runtime.audit.list({ sessionId: "ptc-session" })).some((entry) => entry.toolName === runCodeToolName)).toBe(true);
  }, 30_000);
});
