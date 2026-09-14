import { z } from "zod";

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();

export const runtimeProfileSchema = z.enum(["development", "test", "production"]);
export type RuntimeProfile = z.infer<typeof runtimeProfileSchema>;

export const runtimeConfigSchema = z.object({
  profile: runtimeProfileSchema,
  storage: z.object({
    databasePath: z.string().min(1),
    artifactDirectory: z.string().min(1),
    autoMigrate: z.boolean(),
    busyTimeoutMs: positiveInt,
  }).strict(),
  worker: z.object({
    concurrency: positiveInt.max(128),
    pollIntervalMs: positiveInt.max(60_000),
    leaseMs: positiveInt.max(24 * 60 * 60_000),
    shutdownGracePeriodMs: nonNegativeInt.max(10 * 60_000),
    maxAttempts: positiveInt.max(100),
  }).strict(),
  provider: z.object({
    timeoutMs: positiveInt.max(10 * 60_000),
    maxAttempts: positiveInt.max(20),
    baseBackoffMs: nonNegativeInt.max(60_000),
    maxBackoffMs: positiveInt.max(10 * 60_000),
    jitterRatio: z.number().min(0).max(1),
    circuitFailureThreshold: positiveInt.max(100),
    circuitCooldownMs: positiveInt.max(60 * 60_000),
    maxConcurrentRequests: positiveInt.max(1_024),
    requestsPerSecond: positiveInt.max(10_000),
    sessionTokenBudget: nonNegativeInt,
    costBudget: z.number().nonnegative(),
  }).strict(),
  context: z.object({
    contextLimit: positiveInt,
    generationReserveTokens: nonNegativeInt,
  }).strict(),
  ptc: z.object({
    backend: z.enum(["development-subprocess", "production-container"]),
    maxExecutionMs: positiveInt.max(10 * 60_000),
    maxMemoryMb: positiveInt.min(16).max(4_096),
    network: z.literal("denied"),
    filesystem: z.literal("scratch-only"),
  }).strict(),
  logging: z.object({
    level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]),
    redactSecrets: z.boolean(),
    includePayloads: z.boolean(),
  }).strict(),
  metrics: z.object({ enabled: z.boolean() }).strict(),
  retention: z.object({
    auditMaxRows: positiveInt,
    auditMaxAgeDays: positiveInt,
    artifactCleanupIntervalMs: positiveInt.max(7 * 24 * 60 * 60_000),
    artifactMaxBytes: nonNegativeInt,
  }).strict(),
  security: z.object({
    allowExternalProviders: z.boolean(),
    allowProductionSandbox: z.boolean(),
  }).strict(),
  agents: z.object({
    maxConcurrentAgents: positiveInt.max(128),
    maxConcurrentAgentsPerSession: positiveInt.max(128),
    maxDelegationDepth: nonNegativeInt.max(32),
    maxChildTasks: nonNegativeInt.max(1_000),
    maxReviewIterations: nonNegativeInt.max(32),
    maxReplans: nonNegativeInt.max(32),
  }).strict(),
}).strict().superRefine((config, context) => {
  if (config.provider.maxBackoffMs < config.provider.baseBackoffMs) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["provider", "maxBackoffMs"], message: "maxBackoffMs must be >= baseBackoffMs" });
  }
  if (config.context.generationReserveTokens >= config.context.contextLimit) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["context", "generationReserveTokens"], message: "generation reserve must be below context limit" });
  }
});
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export const defaultRuntimeConfig: RuntimeConfig = runtimeConfigSchema.parse({
  profile: "development",
  storage: { databasePath: "./mnemos.sqlite", artifactDirectory: "./mnemos-artifacts", autoMigrate: true, busyTimeoutMs: 5_000 },
  worker: { concurrency: 2, pollIntervalMs: 250, leaseMs: 30_000, shutdownGracePeriodMs: 10_000, maxAttempts: 8 },
  provider: {
    timeoutMs: 60_000, maxAttempts: 3, baseBackoffMs: 100, maxBackoffMs: 5_000, jitterRatio: 0.2,
    circuitFailureThreshold: 5, circuitCooldownMs: 30_000, maxConcurrentRequests: 8, requestsPerSecond: 60,
    sessionTokenBudget: 0, costBudget: 0,
  },
  context: { contextLimit: 128_000, generationReserveTokens: 20_000 },
  ptc: { backend: "development-subprocess", maxExecutionMs: 15_000, maxMemoryMb: 96, network: "denied", filesystem: "scratch-only" },
  logging: { level: "info", redactSecrets: true, includePayloads: false },
  metrics: { enabled: true },
  retention: { auditMaxRows: 100_000, auditMaxAgeDays: 30, artifactCleanupIntervalMs: 60 * 60_000, artifactMaxBytes: 0 },
  security: { allowExternalProviders: true, allowProductionSandbox: false },
  agents: { maxConcurrentAgents: 4, maxConcurrentAgentsPerSession: 4, maxDelegationDepth: 3, maxChildTasks: 8, maxReviewIterations: 2, maxReplans: 2 },
});

export interface RuntimeConfigSources {
  defaults?: PartialRuntimeConfig;
  file?: PartialRuntimeConfig;
  environment?: NodeJS.ProcessEnv;
  overrides?: PartialRuntimeConfig;
}

export type PartialRuntimeConfig = {
  [K in keyof RuntimeConfig]?: RuntimeConfig[K] extends object ? Partial<RuntimeConfig[K]> : RuntimeConfig[K];
};

/** Resolves defaults → config file → environment → explicit runtime overrides. */
export function resolveRuntimeConfig(sources: RuntimeConfigSources = {}): RuntimeConfig {
  const environment = sources.environment ?? process.env;
  const environmentOverrides: PartialRuntimeConfig = {
    storage: {
      databasePath: environment.MNEMOS_DB_PATH,
      artifactDirectory: environment.MNEMOS_ARTIFACT_DIR,
      autoMigrate: parseBoolean(environment.MNEMOS_AUTO_MIGRATE),
      busyTimeoutMs: parseInteger(environment.MNEMOS_SQLITE_BUSY_TIMEOUT_MS),
    },
    profile: environment.MNEMOS_PROFILE as RuntimeProfile | undefined,
    logging: {
      level: environment.MNEMOS_LOG_LEVEL as RuntimeConfig["logging"]["level"] | undefined,
      redactSecrets: parseBoolean(environment.MNEMOS_REDACT_SECRETS),
      includePayloads: parseBoolean(environment.MNEMOS_LOG_PAYLOADS),
    },
    worker: {
      concurrency: parseInteger(environment.MNEMOS_WORKER_CONCURRENCY),
      pollIntervalMs: parseInteger(environment.MNEMOS_WORKER_POLL_INTERVAL_MS),
      leaseMs: parseInteger(environment.MNEMOS_WORKER_LEASE_MS),
    },
    ptc: { backend: environment.MNEMOS_PTC_BACKEND as RuntimeConfig["ptc"]["backend"] | undefined },
    agents: {
      maxConcurrentAgents: parseInteger(environment.MNEMOS_MAX_CONCURRENT_AGENTS),
      maxConcurrentAgentsPerSession: parseInteger(environment.MNEMOS_MAX_CONCURRENT_AGENTS_PER_SESSION),
      maxDelegationDepth: parseInteger(environment.MNEMOS_MAX_DELEGATION_DEPTH),
      maxChildTasks: parseInteger(environment.MNEMOS_MAX_CHILD_TASKS),
      maxReviewIterations: parseInteger(environment.MNEMOS_MAX_REVIEW_ITERATIONS),
      maxReplans: parseInteger(environment.MNEMOS_MAX_REPLANS),
    },
  };
  return runtimeConfigSchema.parse(deepMerge(
    defaultRuntimeConfig,
    sources.defaults ?? {},
    sources.file ?? {},
    stripUndefined(environmentOverrides),
    sources.overrides ?? {},
  ));
}

export interface SecretProvider {
  get(name: string): Promise<string | undefined>;
}

export class EnvironmentSecretProvider implements SecretProvider {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}
  async get(name: string): Promise<string | undefined> { return this.environment[name]; }
}

/** Replaces known secrets in strings and recursively redacts structured values. */
export function redactSecrets<T>(value: T, secrets: readonly string[] = []): T {
  const known = secrets.filter((secret) => secret.length > 0).sort((a, b) => b.length - a.length);
  const replace = (text: string): string => known.reduce((result, secret) => result.split(secret).join("[REDACTED]"), text);
  const seen = new WeakSet<object>();
  const visit = (current: unknown, key?: string): unknown => {
    if (key !== undefined && /secret|token|password|authorization|api[-_]?key/i.test(key)) return "[REDACTED]";
    if (typeof current === "string") return replace(current);
    if (current === null || typeof current !== "object") return current;
    if (seen.has(current)) return "[CIRCULAR]";
    seen.add(current);
    if (Array.isArray(current)) return current.map((item) => visit(item));
    return Object.fromEntries(Object.entries(current).map(([entryKey, item]) => [entryKey, visit(item, entryKey)]));
  };
  return visit(value) as T;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`Invalid boolean environment override: ${value}`);
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Invalid integer environment override: ${value}`);
  return parsed;
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, stripUndefined(item)]));
}

function deepMerge(...values: readonly unknown[]): unknown {
  const output: Record<string, unknown> = {};
  for (const value of values) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [key, item] of Object.entries(value)) {
      const prior = output[key];
      output[key] = prior !== null && typeof prior === "object" && !Array.isArray(prior) && item !== null && typeof item === "object" && !Array.isArray(item)
        ? deepMerge(prior, item)
        : item;
    }
  }
  return output;
}
