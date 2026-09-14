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
});
