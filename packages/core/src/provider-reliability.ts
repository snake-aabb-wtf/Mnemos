import type { MetricsSink } from "./observability.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "./model.js";

export type ProviderFailureKind = "rate_limited" | "timeout" | "transient" | "auth" | "invalid_request" | "malformed" | "unknown";
export interface ClassifiedProviderError { kind: ProviderFailureKind; retryable: boolean; status?: number; message: string; }

export function classifyProviderError(error: unknown): ClassifiedProviderError {
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  const status = typeof candidate?.status === "number" ? candidate.status : undefined;
  const code = typeof candidate?.code === "string" ? candidate.code.toLocaleLowerCase() : "";
  const message = typeof candidate?.message === "string" ? candidate.message : "Provider execution failed.";
  if (status === 429 || code.includes("rate") || code === "eagain") return { kind: "rate_limited", retryable: true, status, message };
  if (code.includes("timeout") || code === "etimedout" || message.toLocaleLowerCase().includes("timeout")) return { kind: "timeout", retryable: true, status, message };
  if (status !== undefined && status >= 500) return { kind: "transient", retryable: true, status, message };
  if (code.includes("auth") || status === 401 || status === 403) return { kind: "auth", retryable: false, status, message };
  if (status === 400 || code.includes("invalid") || code.includes("schema")) return { kind: "invalid_request", retryable: false, status, message };
  if (code.includes("malformed") || message.toLocaleLowerCase().includes("malformed")) return { kind: "malformed", retryable: false, status, message };
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return { kind: "timeout", retryable: true, status, message };
  return { kind: "unknown", retryable: false, status, message };
}

export interface ProviderExecutionPolicy {
  timeoutMs: number;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  jitterRatio: number;
  circuitFailureThreshold: number;
  circuitCooldownMs: number;
  maxConcurrentRequests?: number;
  requestsPerSecond?: number;
}

export interface RetryRuntime {
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export type CircuitState = "closed" | "open" | "half-open";

export class ProviderCircuitOpenError extends Error { readonly code = "provider_unavailable"; }

export class CircuitBreaker {
  private stateValue: CircuitState = "closed";
  private failures = 0;
  private openedAt = 0;
  private halfOpenInFlight = false;
  constructor(private readonly threshold: number, private readonly cooldownMs: number, private readonly now: () => number = () => Date.now()) {}
  get state(): CircuitState { return this.stateValue; }
  get failureCount(): number { return this.failures; }
  allow(): boolean {
    if (this.stateValue === "closed") return true;
    if (this.stateValue === "open" && this.now() - this.openedAt >= this.cooldownMs) { this.stateValue = "half-open"; this.halfOpenInFlight = false; }
    if (this.stateValue === "half-open") { if (this.halfOpenInFlight) return false; this.halfOpenInFlight = true; return true; }
    return false;
  }
  success(): void { this.failures = 0; this.stateValue = "closed"; this.halfOpenInFlight = false; }
  failure(): void {
    this.halfOpenInFlight = false;
    this.failures += 1;
    if (this.failures >= this.threshold || this.stateValue === "half-open") { this.stateValue = "open"; this.openedAt = this.now(); }
  }
}

export class ProviderRateLimiter {
  private active = 0;
  private nextAllowedAt = 0;
  private schedule: Promise<void> = Promise.resolve();
  private readonly waiters: Array<() => void> = [];
  readonly metrics?: MetricsSink;
  constructor(private readonly maxConcurrent: number, private readonly requestsPerSecond: number, private readonly runtime: RetryRuntime = {}, metrics?: MetricsSink) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || !Number.isInteger(requestsPerSecond) || requestsPerSecond < 1) throw new Error("Provider rate limits must be positive integers");
    this.metrics = metrics;
  }
  get activeRequests(): number { return this.active; }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.schedule;
    let releaseSchedule: () => void = () => undefined;
    this.schedule = new Promise<void>((resolve) => { releaseSchedule = resolve; });
    await prior;
    try {
      const now = (this.runtime.now ?? Date.now)();
      const interval = Math.ceil(1_000 / this.requestsPerSecond);
      const wait = Math.max(0, this.nextAllowedAt - now);
      if (wait > 0) await (this.runtime.sleep ?? delay)(wait);
      this.nextAllowedAt = Math.max((this.runtime.now ?? Date.now)(), this.nextAllowedAt) + interval;
    } finally { releaseSchedule(); }
    if (this.active >= this.maxConcurrent) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    this.metrics?.gauge("provider.active_requests", this.active);
    try { return await operation(); }
    finally {
      this.active -= 1;
      this.waiters.shift()?.();
      this.metrics?.gauge("provider.active_requests", this.active);
    }
  }
}

export interface ProviderExecutionResult<T> { value: T; attempts: number; }

export class ProviderReliabilityExecutor {
  readonly breaker: CircuitBreaker;
  readonly limiter: ProviderRateLimiter;
  constructor(private readonly policy: ProviderExecutionPolicy, private readonly runtime: RetryRuntime = {}, metrics?: MetricsSink) {
    const now = runtime.now ?? (() => Date.now());
    this.breaker = new CircuitBreaker(policy.circuitFailureThreshold, policy.circuitCooldownMs, now);
    this.limiter = new ProviderRateLimiter(policy.maxConcurrentRequests ?? 8, policy.requestsPerSecond ?? 60, runtime, metrics);
    this.metrics = metrics;
  }
  async execute<T>(operation: (signal: AbortSignal, attempt: number) => Promise<T>): Promise<ProviderExecutionResult<T>> {
    if (!this.breaker.allow()) throw new ProviderCircuitOpenError("Provider circuit is open.");
    let attempts = 0;
    const runtime: RetryRuntime = this.runtime;
    while (attempts < this.policy.maxAttempts) {
      attempts += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.policy.timeoutMs);
      try {
        const value = await this.limiter.run(() => Promise.race([
          operation(controller.signal, attempts),
          new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error("Provider timeout"), { name: "TimeoutError", code: "timeout" })), this.policy.timeoutMs)),
        ]));
        clearTimeout(timer);
        this.breaker.success();
        return { value, attempts };
      } catch (error) {
        clearTimeout(timer);
        const classified = classifyProviderError(error);
        if (!classified.retryable || attempts >= this.policy.maxAttempts) { this.breaker.failure(); throw error; }
        const exponential = Math.min(this.policy.maxBackoffMs, this.policy.baseBackoffMs * 2 ** (attempts - 1));
        const random = runtime.random ?? Math.random;
        const jitter = exponential * this.policy.jitterRatio * (random() * 2 - 1);
        this.metrics?.increment("provider.retries", 1, { kind: classified.kind });
        await (runtime.sleep ?? delay)(Math.max(0, Math.round(exponential + jitter)));
      }
    }
    throw new Error("Provider execution exhausted retries.");
  }
  private readonly metrics?: MetricsSink;
}

/** Optional adapter that applies the reliability policy to real ModelProvider calls. */
export class ReliableModelProvider implements ModelProvider {
  constructor(private readonly delegate: ModelProvider, private readonly executor: ProviderReliabilityExecutor) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const execution = await this.executor.execute(() => this.delegate.generate(request));
    return execution.value;
  }
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
