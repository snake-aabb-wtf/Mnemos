import { randomUUID } from "node:crypto";
import { redactSecrets } from "./production.js";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
export interface StructuredLogRecord {
  level: LogLevel;
  message: string;
  timestamp: string;
  fields: Readonly<Record<string, unknown>>;
}

export interface StructuredLogger {
  log(level: LogLevel, fields: Record<string, unknown>, message: string): void;
  child(fields: Record<string, unknown>): StructuredLogger;
}

export class InMemoryStructuredLogger implements StructuredLogger {
  readonly records: StructuredLogRecord[];
  constructor(private readonly fields: Record<string, unknown> = {}, private readonly minimum: LogLevel = "trace", private readonly secrets: readonly string[] = [], records?: StructuredLogRecord[]) { this.records = records ?? []; }

  log(level: LogLevel, fields: Record<string, unknown>, message: string): void {
    if (levelRank(level) < levelRank(this.minimum)) return;
    this.records.push({ level, message, timestamp: new Date().toISOString(), fields: redactSecrets({ ...this.fields, ...fields }, this.secrets) });
  }
  child(fields: Record<string, unknown>): StructuredLogger { return new InMemoryStructuredLogger({ ...this.fields, ...fields }, this.minimum, this.secrets, this.records); }
}

export interface MetricSnapshot {
  counters: Readonly<Record<string, number>>;
  gauges: Readonly<Record<string, number>>;
  histograms: Readonly<Record<string, { count: number; sum: number; p50: number; p95: number; p99: number }>>;
}

export interface MetricsSink {
  increment(name: string, value?: number, labels?: Readonly<Record<string, string>>): void;
  gauge(name: string, value: number, labels?: Readonly<Record<string, string>>): void;
  observe(name: string, value: number, labels?: Readonly<Record<string, string>>): void;
  snapshot(): MetricSnapshot;
}

export class InMemoryMetricsSink implements MetricsSink {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, number[]>();
  increment(name: string, value = 1, labels?: Readonly<Record<string, string>>): void { this.counters.set(metricKey(name, labels), (this.counters.get(metricKey(name, labels)) ?? 0) + value); }
  gauge(name: string, value: number, labels?: Readonly<Record<string, string>>): void { this.gauges.set(metricKey(name, labels), value); }
  observe(name: string, value: number, labels?: Readonly<Record<string, string>>): void { const key = metricKey(name, labels); this.histograms.set(key, [...(this.histograms.get(key) ?? []), value]); }
  snapshot(): MetricSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms: Object.fromEntries([...this.histograms.entries()].map(([key, values]) => [key, {
        count: values.length, sum: values.reduce((sum, value) => sum + value, 0), p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99),
      }])),
    };
  }
}

export class NoopMetricsSink implements MetricsSink {
  increment(): void {}
  gauge(): void {}
  observe(): void {}
  snapshot(): MetricSnapshot { return { counters: {}, gauges: {}, histograms: {} }; }
}

export interface TraceSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startedAt: string;
  endedAt?: string;
  status?: "ok" | "error";
  attributes: Record<string, unknown>;
  end(status?: "ok" | "error"): void;
}

export interface Tracer {
  startSpan(name: string, parent?: TraceSpan, attributes?: Record<string, unknown>): TraceSpan;
  spans(): readonly TraceSpan[];
}

export class InMemoryTracer implements Tracer {
  private readonly entries: TraceSpan[] = [];
  startSpan(name: string, parent?: TraceSpan, attributes: Record<string, unknown> = {}): TraceSpan {
    const span: TraceSpan = {
      traceId: parent?.traceId ?? randomUUID(), spanId: randomUUID(), ...(parent ? { parentSpanId: parent.spanId } : {}), name,
      startedAt: new Date().toISOString(), attributes, end: (status = "ok") => { span.endedAt = new Date().toISOString(); span.status = status; },
    };
    this.entries.push(span);
    return span;
  }
  spans(): readonly TraceSpan[] { return [...this.entries]; }
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  toolTokens?: number;
  provider?: string;
  model?: string;
  operation?: string;
  sessionId?: string;
  agentId?: string;
}

export interface ModelPricing { inputPerToken: number; outputPerToken: number; cachedPerToken?: number; toolPerToken?: number; }
export interface PricingProvider { pricing(provider: string | undefined, model: string | undefined): ModelPricing | undefined; }

export class StaticPricingProvider implements PricingProvider {
  constructor(private readonly values: Readonly<Record<string, ModelPricing>>) {}
  pricing(provider: string | undefined, model: string | undefined): ModelPricing | undefined { return this.values[`${provider ?? "unknown"}/${model ?? "unknown"}`] ?? this.values.default; }
}

export interface UsageRecord extends ProviderUsage { cost: number; recordedAt: string; }

export class InMemoryUsageAccounting {
  readonly records: UsageRecord[] = [];
  constructor(private readonly pricing: PricingProvider) {}
  record(usage: ProviderUsage): UsageRecord {
    const price = this.pricing.pricing(usage.provider, usage.model);
    const cost = price === undefined ? 0
      : (usage.inputTokens ?? 0) * price.inputPerToken
        + (usage.outputTokens ?? 0) * price.outputPerToken
        + (usage.cachedTokens ?? 0) * (price.cachedPerToken ?? price.inputPerToken)
        + (usage.toolTokens ?? 0) * (price.toolPerToken ?? price.inputPerToken);
    const record = { ...usage, cost, recordedAt: new Date().toISOString() };
    this.records.push(record);
    return record;
  }
  totalCost(sessionId?: string): number { return this.records.filter((record) => sessionId === undefined || record.sessionId === sessionId).reduce((sum, record) => sum + record.cost, 0); }
  totalTokens(sessionId?: string): number { return this.records.filter((record) => sessionId === undefined || record.sessionId === sessionId).reduce((sum, record) => sum + (record.inputTokens ?? 0) + (record.outputTokens ?? 0) + (record.cachedTokens ?? 0) + (record.toolTokens ?? 0), 0); }
}

export class BudgetExceededError extends Error { readonly code = "budget_exceeded"; }
export class BudgetGuard {
  constructor(private readonly limits: { tokenBudget?: number; costBudget?: number }, private readonly usage: InMemoryUsageAccounting) {}
  assertWithin(sessionId?: string): void {
    const tokens = this.usage.totalTokens(sessionId);
    const cost = this.usage.totalCost(sessionId);
    if (this.limits.tokenBudget !== undefined && this.limits.tokenBudget > 0 && tokens > this.limits.tokenBudget) throw new BudgetExceededError("Token budget exceeded.");
    if (this.limits.costBudget !== undefined && this.limits.costBudget > 0 && cost > this.limits.costBudget) throw new BudgetExceededError("Cost budget exceeded.");
  }
}

function levelRank(level: LogLevel): number { return ["trace", "debug", "info", "warn", "error", "fatal"].indexOf(level); }
function metricKey(name: string, labels?: Readonly<Record<string, string>>): string {
  if (!labels) return name;
  return `${name}{${Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join(",")}}`;
}
function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(values.length * p) - 1))]!;
}
