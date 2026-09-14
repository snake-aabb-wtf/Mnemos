import { describe, expect, it } from "vitest";
import { DemoConsoleRuntimeService } from "./runtime.js";
import { createServer } from "./index.js";

describe("Console API server", () => {
  it("serves versioned meta, health, readiness, summary, and sessions through Fastify inject", async () => {
    const runtime = new DemoConsoleRuntimeService("test");
    const app = await createServer({ runtime, access: { profile: "test", allowedOrigins: ["http://localhost:5173"] } });
    const meta = await app.inject({ method: "GET", url: "/api/v1/meta", headers: { "x-request-id": "req-meta" } });
    expect(meta.statusCode).toBe(200);
    expect(meta.headers["x-request-id"]).toBe("req-meta");
    expect(meta.json()).toMatchObject({ apiVersion: "v1", version: "0.1.0" });

    expect((await app.inject("/api/v1/health")).json()).toMatchObject({ status: "ok" });
    expect((await app.inject("/api/v1/ready")).statusCode).toBe(200);
    expect((await app.inject("/api/v1/runtime/summary")).json()).toMatchObject({ status: "ready", sessionsCount: 1 });
    expect((await app.inject("/api/v1/sessions?limit=10")).json().items).toHaveLength(1);
    expect((await app.inject("/api/v1/sessions/demo-session-01")).json()).toMatchObject({ id: "demo-session-01", messageCount: 2 });
    await app.close();
  });

  it("maps validation, missing resources, and internal errors without stacks", async () => {
    const runtime = new DemoConsoleRuntimeService("test");
    const app = await createServer({ runtime });
    const invalid = await app.inject("/api/v1/sessions?limit=0");
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(JSON.stringify(invalid.json())).not.toContain("stack");
    expect((await app.inject("/api/v1/sessions/missing")).statusCode).toBe(404);
    await app.close();
  });

  it("disables demo seeding in production", async () => {
    const app = await createServer({ runtime: new DemoConsoleRuntimeService("test"), access: { profile: "production" } });
    expect((await app.inject({ method: "POST", url: "/api/v1/dev/demo-session" })).statusCode).toBe(404);
    await app.close();
  });

  it("does not grant CORS access to an unconfigured origin", async () => {
    const app = await createServer({ runtime: new DemoConsoleRuntimeService("test"), access: { profile: "production", allowedOrigins: ["https://console.example"] } });
    const response = await app.inject({ method: "GET", url: "/api/v1/meta", headers: { origin: "https://attacker.example" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("streams only safe allowlisted events and removes listeners on disconnect", async () => {
    const runtime = new DemoConsoleRuntimeService("test");
    const app = await createServer({ runtime });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("server did not bind");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/events`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("event stream connected");
    expect(runtime.events.listenerCount("runtime.ready")).toBe(1);
    await runtime.events.emit("runtime.ready", { runtimeVersion: "0.1.0", schemaVersion: 1 });
    const next = await reader.read();
    const text = new TextDecoder().decode(next.value);
    expect(text).toContain("runtime.ready");
    expect(text).not.toContain("secret");
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runtime.events.listenerCount("runtime.ready")).toBe(0);
    await app.close();
  });

  it("creates sessions, streams canonical chat messages, and preserves history after refresh", async () => {
    const runtime = new DemoConsoleRuntimeService("test");
    const app = await createServer({ runtime });
    const created = await app.inject({ method: "POST", url: "/api/v1/sessions", payload: { displayName: "Chat test" } });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().id as string;
    expect((await app.inject(`/api/v1/sessions/${sessionId}/messages`)).json().items).toHaveLength(0);
    const accepted = await app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/messages`, payload: { content: "Explain the runtime." } });
    expect(accepted.statusCode).toBe(202);
    const generationId = accepted.json().generationId as string;
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("server did not bind");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/sessions/${sessionId}/generations/${generationId}/events`);
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let text = "";
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value); if (text.includes("event: chat.completed")) break; }
    expect(text).toContain("event: chat.started"); expect(text).toContain("event: chat.activity"); expect(text).toContain("event: chat.text_delta"); expect(text).toContain("event: chat.completed");
    const messages = (await app.inject(`/api/v1/sessions/${sessionId}/messages`)).json().items;
    expect(messages).toHaveLength(2); expect(messages[0]).toMatchObject({ role: "user", content: "Explain the runtime." }); expect(messages[1]).toMatchObject({ role: "assistant", status: "completed" });
    const retrieval = await app.inject(`/api/v1/sessions/${sessionId}/messages/${messages[1].id}/retrieval`); expect(retrieval.statusCode).toBe(200); expect(retrieval.json().results[0]).toMatchObject({ rank: 1, matchedBy: ["lexical", "semantic"] });
    await app.close();
  });

  it("propagates cancellation and creates a separate retry attempt", async () => {
    const runtime = new DemoConsoleRuntimeService("test"); const app = await createServer({ runtime });
    const created = await app.inject({ method: "POST", url: "/api/v1/sessions", payload: {} }); const sessionId = created.json().id as string;
    const accepted = await app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/messages`, payload: { content: "Please continue [long]" } }); const generationId = accepted.json().generationId as string;
    const cancelled = await app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/generations/${generationId}/cancel` }); expect(cancelled.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const messages = (await app.inject(`/api/v1/sessions/${sessionId}/messages`)).json().items; const assistant = messages.find((message: { role: string }) => message.role === "assistant");
    expect(assistant).toMatchObject({ status: "cancelled" });
    const retry = await app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/messages/${assistant.id}/retry` }); expect(retry.statusCode).toBe(202); expect(retry.json().assistantMessageId).not.toBe(assistant.id);
    await app.close();
  });

  it("records deterministic runtime failures without losing the user message", async () => {
    const runtime = new DemoConsoleRuntimeService("test"); const app = await createServer({ runtime });
    const created = await app.inject({ method: "POST", url: "/api/v1/sessions", payload: {} }); const sessionId = created.json().id as string;
    const accepted = await app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/messages`, payload: { content: "Exercise a failure [fail]" } }); expect(accepted.statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const messages = (await app.inject(`/api/v1/sessions/${sessionId}/messages`)).json().items;
    expect(messages).toHaveLength(2); expect(messages[0]).toMatchObject({ role: "user", content: "Exercise a failure [fail]" }); expect(messages[1]).toMatchObject({ role: "assistant", status: "failed" });
    await app.close();
  });

  it("serves bounded context telemetry, memory search, and canonical provenance", async () => {
    const runtime = new DemoConsoleRuntimeService("test"); const app = await createServer({ runtime });
    const context = await app.inject("/api/v1/sessions/demo-session-01/context");
    expect(context.statusCode).toBe(200); expect(context.json()).toMatchObject({ sessionId: "demo-session-01", stats: { contextLimit: 131072, pressureLevel: "NORMAL" } });
    const search = await app.inject("/api/v1/memory?query=TypeScript&limit=10");
    expect(search.statusCode).toBe(200); expect(search.json().items[0]).toMatchObject({ id: "memory-typescript", status: "active" });
    const detail = await app.inject("/api/v1/memory/memory-typescript"); expect(detail.statusCode).toBe(200); expect(detail.json().sourceReferences).toHaveLength(2);
    const sources = await app.inject("/api/v1/memory/memory-typescript/sources"); expect(sources.statusCode).toBe(200); expect(sources.json()[0]).toMatchObject({ messageId: "demo-session-01-m1" });
    const history = await app.inject("/api/v1/sessions/demo-session-01/history/demo-session-01-m1"); expect(history.statusCode).toBe(200); expect(history.json()).toMatchObject({ role: "user", id: "demo-session-01-m1" });
    await app.close();
  });

  it("serves bounded artifact, tool, PTC, agent, task, metrics, and operations DTOs", async () => {
    const app = await createServer({ runtime: new DemoConsoleRuntimeService("test") });
    const artifacts = await app.inject("/api/v1/artifacts?limit=10"); expect(artifacts.statusCode).toBe(200); expect(artifacts.json().items[0]).toMatchObject({ id: "artifact://demo-research", sizeBytes: 184320 });
    const artifact = await app.inject("/api/v1/artifacts/artifact%3A%2F%2Fdemo-research/preview"); expect(artifact.statusCode).toBe(200); expect(artifact.json().preview.content.length).toBeLessThanOrEqual(16384); expect(JSON.stringify(artifact.json())).not.toContain("secret");
    const range = await app.inject("/api/v1/artifacts/artifact%3A%2F%2Fdemo-research/range?offset=2&length=12"); expect(range.statusCode).toBe(200); expect(range.json().range.length).toBeLessThanOrEqual(12);
    const tools = await app.inject("/api/v1/tools?loaded=true&limit=20"); expect(tools.statusCode).toBe(200); expect(tools.json().items.some((tool: { name: string }) => tool.name === "run_code")).toBe(true);
    const ptc = await app.inject("/api/v1/ptc/executions?limit=10"); expect(ptc.statusCode).toBe(200); const ptcDetail = await app.inject(`/api/v1/ptc/executions/${ptc.json().items[0].id}`); expect(ptcDetail.statusCode).toBe(200); expect(ptcDetail.json().timeline.length).toBeGreaterThan(0);
    const agents = await app.inject("/api/v1/agents?limit=20"); expect(agents.statusCode).toBe(200); expect(agents.json().items.some((agent: { id: string }) => agent.id === "planner")).toBe(true);
    const tasks = await app.inject("/api/v1/tasks?limit=20"); expect(tasks.statusCode).toBe(200); expect(tasks.json().items.length).toBeGreaterThan(3);
    const graph = await app.inject("/api/v1/tasks/graph"); expect(graph.statusCode).toBe(200); expect(graph.json().nodes.length).toBeGreaterThan(3); expect(graph.json().edges.length).toBeGreaterThan(0);
    expect((await app.inject("/api/v1/runtime/metrics")).json()).toMatchObject({ contextPressure: 0.287, sessions: 1 }); expect((await app.inject("/api/v1/runtime/operations")).json()).toMatchObject({ sandbox: { status: "available" }, migrations: { pending: 0 } });
    await app.close();
  });
});
