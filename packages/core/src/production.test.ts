import { describe, expect, it } from "vitest";
import {
  BudgetExceededError,
  BudgetGuard,
  CircuitBreaker,
  ContainerSandboxBackend,
  EnvironmentSecretProvider,
  InMemoryMetricsSink,
  InMemoryStructuredLogger,
  InMemoryTracer,
  InMemoryUsageAccounting,
  RuntimeHealthService,
  RuntimeLifecycle,
  SessionMutex,
  ProviderCircuitOpenError,
  ProviderRateLimiter,
  ProviderReliabilityExecutor,
  StaticPricingProvider,
  classifyProviderError,
  defaultRuntimeConfig,
  redactSecrets,
  resolveRuntimeConfig,
} from "./index.js";

describe("Phase 13 production primitives", () => {
  it("validates precedence and rejects invalid production configuration", () => {
    const config = resolveRuntimeConfig({
      file: { storage: { databasePath: "file.sqlite" }, logging: { level: "warn" } },
      environment: { MNEMOS_DB_PATH: "env.sqlite", MNEMOS_WORKER_CONCURRENCY: "4" },
      overrides: { storage: { databasePath: "explicit.sqlite" } },
    });
    expect(config.storage.databasePath).toBe("explicit.sqlite");
    expect(config.worker.concurrency).toBe(4);
    expect(config.logging.level).toBe("warn");
    expect(() => resolveRuntimeConfig({ overrides: { context: { contextLimit: 1, generationReserveTokens: 1 } } })).toThrow();
    expect(defaultRuntimeConfig.storage.busyTimeoutMs).toBeGreaterThan(0);
  });

  it("keeps secrets out of nested diagnostics and exposes replaceable SecretProvider", async () => {
    const provider = new EnvironmentSecretProvider({ TEST_SECRET_ABC123: "TEST_SECRET_ABC123" });
    expect(await provider.get("TEST_SECRET_ABC123")).toBe("TEST_SECRET_ABC123");
    const redacted = redactSecrets({ authorization: "TEST_SECRET_ABC123", nested: { message: "failed TEST_SECRET_ABC123" }, list: ["TEST_SECRET_ABC123"] }, ["TEST_SECRET_ABC123"]);
    expect(JSON.stringify(redacted)).not.toContain("TEST_SECRET_ABC123");
    expect(redacted).toMatchObject({ authorization: "[REDACTED]", nested: { message: "failed [REDACTED]" } });
  });

  it("provides correlated structured logs, metrics, tracing, and budget accounting", () => {
    const logger = new InMemoryStructuredLogger({}, "info", ["secret"]);
    logger.child({ requestId: "r1" }).log("info", { value: "secret" }, "request");
    expect(logger.records[0]).toMatchObject({ fields: { requestId: "r1", value: "[REDACTED]" } });
    const metrics = new InMemoryMetricsSink();
    metrics.increment("requests.total"); metrics.gauge("queue.depth", 2); metrics.observe("request.duration", 10); metrics.observe("request.duration", 20);
    expect(metrics.snapshot()).toMatchObject({ counters: { "requests.total": 1 }, gauges: { "queue.depth": 2 }, histograms: { "request.duration": { count: 2, p50: 10, p95: 20 } } });
    const tracer = new InMemoryTracer();
    const root = tracer.startSpan("request", undefined, { requestId: "r1" });
    const child = tracer.startSpan("provider", root); child.end(); root.end();
    expect(tracer.spans()[1]).toMatchObject({ traceId: root.traceId, parentSpanId: root.spanId, status: "ok" });
    const usage = new InMemoryUsageAccounting(new StaticPricingProvider({ default: { inputPerToken: 0.01, outputPerToken: 0.02 } }));
    usage.record({ inputTokens: 10, outputTokens: 5, sessionId: "s" });
    expect(usage.totalTokens("s")).toBe(15);
    const guard = new BudgetGuard({ tokenBudget: 10 }, usage);
    expect(() => guard.assertWithin("s")).toThrow(BudgetExceededError);
  });

  it("classifies failures, retries transient errors, and opens a circuit", async () => {
    expect(classifyProviderError({ status: 429, message: "busy" })).toMatchObject({ kind: "rate_limited", retryable: true });
    expect(classifyProviderError({ status: 401, message: "no" })).toMatchObject({ kind: "auth", retryable: false });
    let attempts = 0;
    const executor = new ProviderReliabilityExecutor({ timeoutMs: 100, maxAttempts: 3, baseBackoffMs: 0, maxBackoffMs: 0, jitterRatio: 0, circuitFailureThreshold: 2, circuitCooldownMs: 100, maxConcurrentRequests: 2, requestsPerSecond: 10_000 }, { sleep: async () => undefined, random: () => 0.5 });
    const result = await executor.execute(async () => { attempts += 1; if (attempts < 3) throw Object.assign(new Error("temporary"), { status: 503 }); return "ok"; });
    expect(result).toEqual({ value: "ok", attempts: 3 });
    await expect(executor.execute(async () => { throw Object.assign(new Error("temporary"), { status: 503 }); })).rejects.toThrow("temporary");
    await expect(executor.execute(async () => { throw Object.assign(new Error("temporary"), { status: 503 }); })).rejects.toThrow("temporary");
    await expect(executor.execute(async () => "never")).rejects.toBeInstanceOf(ProviderCircuitOpenError);
  });

  it("supports deterministic circuit half-open recovery and fails closed for unavailable containers", async () => {
    let now = 0;
    const breaker = new CircuitBreaker(1, 100, () => now);
    expect(breaker.allow()).toBe(true); breaker.failure(); expect(breaker.state).toBe("open"); expect(breaker.allow()).toBe(false);
    now = 100; expect(breaker.allow()).toBe(true); breaker.success(); expect(breaker.state).toBe("closed");
    const container = new ContainerSandboxBackend("definitely-not-a-real-docker");
    expect(await container.isAvailable()).toBe(false);
  });

  it("enforces provider concurrency without real sleeping", async () => {
    const limiter = new ProviderRateLimiter(2, 10_000, { sleep: async () => undefined });
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 8 }, () => limiter.run(async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
    })));
    expect(peak).toBe(2);
  });

  it("keeps liveness cheap and separates readiness dependency failures", async () => {
    const health = new RuntimeHealthService([{ name: "db", check: async () => ({ ok: true }) }, { name: "worker", check: async () => ({ ok: false, detail: "stopped" }) }], "test-build");
    expect(health.liveness()).toMatchObject({ status: "ok", version: "test-build" });
    expect(await health.readiness()).toMatchObject({ status: "not_ready", checks: [{ name: "db", ok: true }, { name: "worker", ok: false }] });
  });

  it("shuts down in a deterministic worker → audit → sandbox → store order", async () => {
    const order: string[] = [];
    const lifecycle = new RuntimeLifecycle({ runtimeVersion: "test", profile: "test", shutdownGracePeriodMs: 10, stopWorkers: async () => { order.push("workers"); }, flushAudit: async () => { order.push("audit"); }, terminateSandboxes: async () => { order.push("sandboxes"); }, closeStores: async () => { order.push("stores"); } });
    await lifecycle.start(); await lifecycle.shutdown(); await lifecycle.shutdown();
    expect(order).toEqual(["workers", "audit", "sandboxes", "stores"]);
  });

  it("serializes one session while allowing independent session work", async () => {
    const mutex = new SessionMutex();
    const order: string[] = [];
    await Promise.all([mutex.run("a", async () => { order.push("a1"); await new Promise((resolve) => setTimeout(resolve, 3)); order.push("a2"); }), mutex.run("a", async () => { order.push("a3"); }), mutex.run("b", async () => { order.push("b1"); })]);
    expect(order.indexOf("a2")).toBeLessThan(order.indexOf("a3"));
    expect(order).toContain("b1");
  });
});
