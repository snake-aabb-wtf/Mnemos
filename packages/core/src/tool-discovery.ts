import { createHash } from "node:crypto";
import { z } from "zod";
import type { EventBus, HarnessEventMap } from "./events.js";
import type { ModelToolDeclaration } from "./model.js";
import {
  type ToolDescriptor,
  type ToolDefinition,
  type ToolDispatchContext,
  type ToolExecutionContext,
  type ToolName,
  type ToolPermission,
  type ToolRegistry,
  type ToolSideEffect,
  toolPermissionSchema,
} from "./tool.js";

export const defaultCoreToolNames: readonly ToolName[] = [
  "run_code", "tools.search", "tools.describe", "context.inspect", "memory.search",
];

export interface ToolExposurePolicy {
  coreToolNames?: readonly ToolName[];
  maxLoadedDynamicTools: number;
  toolSchemaTokenBudget: number;
  maxSearchResults: number;
  maxSearchResultBytes: number;
  maxDescribeTools: number;
  maxDescribeBytes: number;
}

export const defaultToolExposurePolicy: ToolExposurePolicy = {
  coreToolNames: defaultCoreToolNames,
  maxLoadedDynamicTools: 16,
  toolSchemaTokenBudget: 8_000,
  maxSearchResults: 8,
  maxSearchResultBytes: 16 * 1024,
  maxDescribeTools: 8,
  maxDescribeBytes: 128 * 1024,
};

export type ToolDiscoverySideEffect = ToolSideEffect;

export interface ToolDiscoveryMetadata {
  name: ToolName;
  namespace: string;
  description: string;
  shortSummary: string;
  tags: readonly string[];
  capabilities: readonly string[];
  requiredPermissions: readonly ToolPermission[];
  sideEffect: ToolDiscoverySideEffect;
  concurrencySafe: boolean;
  provider?: string;
  version?: string;
  visibility: "agent" | "internal";
  schemaHash: string;
}

export interface ToolDiscoveryCandidate extends ToolDiscoveryMetadata {
  score: number;
  available: boolean;
  unavailableReason?: "permission_denied" | "not_loaded";
}

export interface ToolDiscoverySearchInput {
  query: string;
  limit?: number;
  namespace?: string;
  capability?: string;
  sideEffect?: ToolSideEffect;
  provider?: string;
  includeUnavailable?: boolean;
}

export interface ToolDiscoverySearchResult {
  candidates: readonly ToolDiscoveryCandidate[];
  totalCandidates: number;
  truncated: boolean;
}

export interface ToolDiscoveryDescribeInput {
  names: readonly string[];
}

export interface ToolDiscoveryDescription {
  name: ToolName;
  metadata: ToolDiscoveryMetadata;
  inputSchema?: unknown;
  outputSchema?: unknown;
  available: boolean;
  loaded: boolean;
  error?: "permission_denied" | "tool_not_found" | "schema_budget_exceeded" | "max_loaded_dynamic_tools";
}

export interface ToolDiscoveryDescribeResult {
  tools: readonly ToolDiscoveryDescription[];
  loadedNames: readonly ToolName[];
  unloadedNames: readonly ToolName[];
  rejectedNames: readonly string[];
  truncated: boolean;
}

export interface LoadedToolSnapshot {
  readonly coreNames: readonly ToolName[];
  readonly dynamicNames: readonly ToolName[];
  readonly names: readonly ToolName[];
  readonly schemaTokens: number;
}

function normalize(value: string): string[] {
  return value.toLocaleLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

export function toolSchemaHash(descriptor: ToolDescriptor): string {
  const payload = {
    name: descriptor.name, description: descriptor.description, shortSummary: descriptor.shortSummary,
    tags: descriptor.tags, capabilities: descriptor.capabilities, requiredPermissions: descriptor.requiredPermissions,
    sideEffect: descriptor.sideEffect, concurrencySafe: descriptor.concurrencySafe, provider: descriptor.provider,
    version: descriptor.version, visibility: descriptor.visibility, inputSchema: descriptor.inputSchema,
    outputSchema: descriptor.outputSchema,
  };
  return createHash("sha256").update(canonical(payload)).digest("hex").slice(0, 16);
}

function metadataFromDescriptor(descriptor: ToolDescriptor): ToolDiscoveryMetadata {
  const namespace = descriptor.name.includes(".") ? descriptor.name.slice(0, descriptor.name.indexOf(".")) : "runtime";
  return {
    name: descriptor.name, namespace, description: descriptor.description,
    shortSummary: descriptor.shortSummary ?? descriptor.description.slice(0, 140),
    tags: descriptor.tags ?? [], capabilities: descriptor.capabilities ?? [],
    requiredPermissions: descriptor.requiredPermissions, sideEffect: descriptor.sideEffect,
    concurrencySafe: descriptor.concurrencySafe, ...(descriptor.provider === undefined ? {} : { provider: descriptor.provider }),
    ...(descriptor.version === undefined ? {} : { version: descriptor.version }),
    visibility: descriptor.visibility ?? "agent", schemaHash: toolSchemaHash(descriptor),
  };
}

function permitted(metadata: ToolDiscoveryMetadata, grants: readonly ToolPermission[]): boolean {
  return metadata.requiredPermissions.every((permission) => grants.includes(permission));
}

function boundedJsonBytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value)); } catch { return Number.POSITIVE_INFINITY; }
}

/** Rebuildable lexical index derived from ToolRegistry descriptors. */
export class ToolDiscoveryIndex {
  private readonly entries = new Map<ToolName, { descriptor: ToolDescriptor; metadata: ToolDiscoveryMetadata; terms: Set<string> }>();
  private readonly unsubscribe: () => void;

  constructor(private readonly registry: ToolRegistry) {
    this.rebuild();
    this.unsubscribe = registry.subscribe((change) => {
      if (change.kind === "unregistered") this.remove(change.name);
      else this.update(change.name);
    });
  }

  dispose(): void { this.unsubscribe(); }

  rebuild(): void {
    this.entries.clear();
    for (const descriptor of this.registry.list()) this.index(descriptor);
  }

  index(descriptor: ToolDescriptor): void {
    const metadata = metadataFromDescriptor(descriptor);
    const terms = new Set(normalize([
      descriptor.name, descriptor.description, metadata.shortSummary,
      ...(metadata.tags), ...(metadata.capabilities), ...(metadata.provider === undefined ? [] : [metadata.provider]),
    ].join(" ")));
    this.entries.set(descriptor.name, { descriptor, metadata, terms });
  }

  update(name: ToolName): void {
    const descriptor = this.registry.list().find((item) => item.name === name);
    if (descriptor) this.index(descriptor); else this.remove(name);
  }

  remove(name: ToolName): void { this.entries.delete(name); }

  get(name: string): ToolDiscoveryMetadata | undefined {
    return this.entries.get(name as ToolName)?.metadata;
  }

  search(input: ToolDiscoverySearchInput, grants: readonly ToolPermission[], maxResults = 20): readonly ToolDiscoveryCandidate[] {
    const queryTokens = normalize(input.query);
    const queryText = input.query.trim().toLocaleLowerCase();
    const candidates: ToolDiscoveryCandidate[] = [];
    for (const entry of this.entries.values()) {
      const { metadata } = entry;
      if (metadata.visibility === "internal") continue;
      if (input.namespace !== undefined && metadata.namespace !== input.namespace) continue;
      if (input.capability !== undefined && !metadata.capabilities.includes(input.capability)) continue;
      if (input.sideEffect !== undefined && metadata.sideEffect !== input.sideEffect) continue;
      if (input.provider !== undefined && metadata.provider !== input.provider) continue;
      const available = permitted(metadata, grants);
      if (!available && input.includeUnavailable === false) continue;
      let score = queryTokens.length === 0 ? 1 : 0;
      if (queryText && metadata.name.toLocaleLowerCase() === queryText) score += 1_000;
      if (queryText && metadata.namespace.toLocaleLowerCase() === queryText) score += 500;
      for (const token of queryTokens) {
        if (entry.terms.has(token)) score += 100;
        if (metadata.name.toLocaleLowerCase().includes(token)) score += 80;
        if (metadata.tags.some((tag) => normalize(tag).includes(token))) score += 30;
        if (metadata.capabilities.some((capability) => normalize(capability).includes(token))) score += 20;
      }
      if (queryTokens.length > 0 && score === 0) continue;
      candidates.push({ ...metadata, score, available, ...(available ? {} : { unavailableReason: "permission_denied" as const }) });
    }
    return candidates.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name)).slice(0, maxResults);
  }
}

interface LoadedEntry { lastUsed: number; schemaTokens: number; }

/** Session-scoped dynamic catalog with deterministic LRU and schema budgets. */
export class LoadedToolSet {
  private readonly dynamic = new Map<ToolName, LoadedEntry>();
  private clock = 0;

  constructor(private readonly registry: ToolRegistry, private readonly policy: ToolExposurePolicy, private readonly coreNames: readonly ToolName[]) {}

  snapshot(grants: readonly ToolPermission[]): LoadedToolSnapshot {
    for (const name of this.dynamic.keys()) {
      const current = this.registry.list().find((item) => item.name === name);
      if (current === undefined || current.visibility === "internal") this.dynamic.delete(name);
    }
    const coreNames = this.coreNames.filter((name) => {
      const descriptor = this.registry.list().find((item) => item.name === name);
      return descriptor !== undefined && descriptor.visibility !== "internal" && permitted(metadataFromDescriptor(descriptor), grants);
    });
    const dynamicNames = [...this.dynamic.keys()].filter((name) => {
      const descriptor = this.registry.list().find((item) => item.name === name);
      return descriptor !== undefined && descriptor.visibility !== "internal" && permitted(metadataFromDescriptor(descriptor), grants);
    });
    const names = [...new Set([...coreNames, ...dynamicNames])];
    const schemaTokens = names.reduce((sum, name) => {
      const descriptor = this.registry.list().find((item) => item.name === name);
      return sum + (descriptor === undefined ? 0 : estimateSchemaTokens(descriptor));
    }, 0);
    return { coreNames, dynamicNames, names, schemaTokens };
  }

  touch(name: ToolName): void {
    const current = this.dynamic.get(name);
    if (current) this.dynamic.set(name, { ...current, lastUsed: ++this.clock });
  }

  load(names: readonly ToolName[], grants: readonly ToolPermission[]): { loadedNames: ToolName[]; rejected: Array<{ name: string; error: ToolDiscoveryDescription["error"] }> } {
    const loadedNames: ToolName[] = [];
    const rejected: Array<{ name: string; error: ToolDiscoveryDescription["error"] }> = [];
    for (const name of names) {
      const descriptor = this.registry.list().find((item) => item.name === name);
      if (!descriptor) { rejected.push({ name, error: "tool_not_found" }); continue; }
      const metadata = metadataFromDescriptor(descriptor);
      if (!permitted(metadata, grants)) { rejected.push({ name, error: "permission_denied" }); continue; }
      if (this.coreNames.includes(name)) { loadedNames.push(name); continue; }
      const schemaTokens = estimateSchemaTokens(descriptor);
      if (schemaTokens > this.policy.toolSchemaTokenBudget) { rejected.push({ name, error: "schema_budget_exceeded" }); continue; }
      this.dynamic.set(name, { schemaTokens, lastUsed: ++this.clock });
      while (this.dynamic.size > this.policy.maxLoadedDynamicTools) this.evictOldest();
      while (this.currentDynamicTokens() > this.policy.toolSchemaTokenBudget && this.dynamic.size > 1) this.evictOldest(name);
      if (!this.dynamic.has(name)) rejected.push({ name, error: "max_loaded_dynamic_tools" });
      else if (this.currentDynamicTokens() > this.policy.toolSchemaTokenBudget) { this.dynamic.delete(name); rejected.push({ name, error: "schema_budget_exceeded" }); }
      else loadedNames.push(name);
    }
    return { loadedNames, rejected };
  }

  unload(names: readonly ToolName[]): void {
    for (const name of names) {
      if (!this.coreNames.includes(name)) this.dynamic.delete(name);
    }
  }

  private currentDynamicTokens(): number { return [...this.dynamic.values()].reduce((sum, item) => sum + item.schemaTokens, 0); }

  private evictOldest(except?: ToolName): void {
    const candidate = [...this.dynamic.entries()].filter(([name]) => name !== except).sort((left, right) => left[1].lastUsed - right[1].lastUsed || left[0].localeCompare(right[0]))[0];
    if (candidate) this.dynamic.delete(candidate[0]);
  }
}

function estimateSchemaTokens(descriptor: ToolDescriptor): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(canonical({ name: descriptor.name, description: descriptor.description, inputSchema: descriptor.inputSchema, outputSchema: descriptor.outputSchema })) / 4));
}

export interface ToolDiscoveryRuntimeOptions {
  registry: ToolRegistry;
  index?: ToolDiscoveryIndex;
  policy?: Partial<ToolExposurePolicy>;
  events?: EventBus<HarnessEventMap>;
}

/** Host-side discovery coordinator. It owns no tool execution authority. */
export class ToolDiscoveryRuntime {
  readonly policy: ToolExposurePolicy;
  readonly index: ToolDiscoveryIndex;
  private readonly sessions = new Map<string, LoadedToolSet>();

  constructor(private readonly options: ToolDiscoveryRuntimeOptions) {
    this.policy = { ...defaultToolExposurePolicy, ...options.policy, coreToolNames: options.policy?.coreToolNames ?? defaultCoreToolNames };
    for (const [key, value] of Object.entries(this.policy)) {
      if (key !== "coreToolNames" && (!Number.isInteger(value) || (value as number) <= 0)) throw new Error(`Invalid discovery policy: ${key}`);
    }
    this.index = options.index ?? new ToolDiscoveryIndex(options.registry);
  }

  loadedSet(sessionId: string): LoadedToolSet {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created = new LoadedToolSet(this.options.registry, this.policy, this.policy.coreToolNames ?? []);
    this.sessions.set(sessionId, created);
    return created;
  }

  snapshot(sessionId: string, grants: readonly ToolPermission[]): LoadedToolSnapshot {
    return this.loadedSet(sessionId).snapshot(grants);
  }

  dispatchableNames(sessionId: string, grants: readonly ToolPermission[]): readonly ToolName[] {
    return this.snapshot(sessionId, grants).names;
  }

  declarations(sessionId: string, grants: readonly ToolPermission[]): readonly ModelToolDeclaration[] {
    const snapshot = this.snapshot(sessionId, grants);
    const names = new Set(snapshot.names);
    return this.options.registry.nativeDeclarations().filter((tool) => names.has(tool.name));
  }

  sdkToolNames(sessionId: string, grants: readonly ToolPermission[]): readonly ToolName[] {
    return this.snapshot(sessionId, grants).names;
  }

  search(input: ToolDiscoverySearchInput, grants: readonly ToolPermission[]): ToolDiscoverySearchResult {
    const limit = Math.min(input.limit ?? this.policy.maxSearchResults, this.policy.maxSearchResults);
    const all = this.index.search({ ...input, includeUnavailable: input.includeUnavailable ?? true }, grants, limit);
    let candidates = [...all];
    let truncated = false;
    while (candidates.length > 0 && boundedJsonBytes({ candidates }) > this.policy.maxSearchResultBytes) { candidates.pop(); truncated = true; }
    return { candidates, totalCandidates: all.length, truncated: truncated || all.length > candidates.length };
  }

  describe(sessionId: string, input: ToolDiscoveryDescribeInput, grants: readonly ToolPermission[]): ToolDiscoveryDescribeResult {
    const before = this.loadedSet(sessionId).snapshot(grants);
    const names = input.names.slice(0, this.policy.maxDescribeTools);
    const rejectedNames = input.names.slice(this.policy.maxDescribeTools).map(String);
    const loaded = this.loadedSet(sessionId).load(names.filter((name): name is ToolName => typeof name === "string") as ToolName[], grants);
    const loadedNames = loaded.loadedNames;
    const after = this.loadedSet(sessionId).snapshot(grants);
    const unloadedNames = before.dynamicNames.filter((name) => !after.dynamicNames.includes(name));
    const tools: ToolDiscoveryDescription[] = [];
    for (const name of names) {
      const descriptor = this.options.registry.list().find((item) => item.name === name);
      if (!descriptor) { tools.push({ name: name as ToolName, metadata: fakeMetadata(name), available: false, loaded: false, error: "tool_not_found" }); continue; }
      const metadata = metadataFromDescriptor(descriptor);
      const available = permitted(metadata, grants);
      if (!available) { tools.push({ name, metadata, available: false, loaded: false, error: "permission_denied" }); continue; }
      const loadedNow = loadedNames.includes(name);
      tools.push({ name, metadata, inputSchema: descriptor.inputSchema, ...(descriptor.outputSchema === undefined ? {} : { outputSchema: descriptor.outputSchema }), available: true, loaded: loadedNow });
    }
    let truncated = false;
    const omittedByBytes: ToolName[] = [];
    while (tools.length > 0 && boundedJsonBytes({ tools }) > this.policy.maxDescribeBytes) {
      const omitted = tools.pop();
      if (omitted) omittedByBytes.push(omitted.name);
      truncated = true;
    }
    this.loadedSet(sessionId).unload(omittedByBytes);
    const retainedLoadedNames = loadedNames.filter((name) => !omittedByBytes.includes(name));
    return { tools, loadedNames: retainedLoadedNames, unloadedNames: [...unloadedNames, ...omittedByBytes], rejectedNames: [...rejectedNames, ...loaded.rejected.map((item) => item.name)], truncated };
  }

  async emitSearch(sessionId: string, agentId: string, query: string, result: ToolDiscoverySearchResult, durationMs: number): Promise<void> {
    await this.options.events?.emit("tool.discovery.searched", { sessionId, agentId, query, candidateCount: result.candidates.length, durationMs });
  }

  async emitDescribe(sessionId: string, agentId: string, names: readonly string[], result: ToolDiscoveryDescribeResult, durationMs: number): Promise<void> {
    const schemaTokenEstimate = result.tools.reduce((sum, tool) => sum + (tool.inputSchema === undefined ? 0 : Math.ceil(boundedJsonBytes(tool.inputSchema) / 4)), 0);
    await this.options.events?.emit("tool.discovery.described", { sessionId, agentId, names: [...names], loadedNames: [...result.loadedNames], schemaTokenEstimate, durationMs });
    if (result.loadedNames.length > 0) await this.options.events?.emit("tool.loaded", { sessionId, agentId, toolNames: [...result.loadedNames], schemaTokenEstimate });
    if (result.unloadedNames.length > 0) await this.options.events?.emit("tool.unloaded", { sessionId, agentId, toolNames: [...result.unloadedNames], reason: "lru" });
  }
}

function fakeMetadata(name: string): ToolDiscoveryMetadata {
  return { name: name as ToolName, namespace: name.includes(".") ? name.slice(0, name.indexOf(".")) : "runtime", description: "Unknown tool.", shortSummary: "Unknown tool.", tags: [], capabilities: [], requiredPermissions: [], sideEffect: "none", concurrencySafe: true, visibility: "agent", schemaHash: "unknown" };
}

export const toolDiscoverySearchInputSchema = z.object({
  query: z.string().trim().max(512).default(""), limit: z.number().int().positive().max(64).optional(),
  namespace: z.string().trim().max(64).optional(), capability: z.string().trim().max(128).optional(),
  sideEffect: z.enum(["none", "read", "write", "destructive"]).optional(), provider: z.string().trim().max(128).optional(),
  includeUnavailable: z.boolean().optional(),
}).strict();
export const toolDiscoveryDescribeInputSchema = z.object({ names: z.array(z.string().trim().min(1).max(256)).min(1).max(64) }).strict();

export function registerToolDiscoveryTools(registry: ToolRegistry, runtime: ToolDiscoveryRuntime): void {
  const search: ToolDefinition<ToolDiscoverySearchInput, ToolDiscoverySearchResult> = {
    name: "tools.search", description: "Find available tools by lexical query and metadata filters.", shortSummary: "Search the tool catalog.", tags: ["discovery", "catalog"], capabilities: ["tool-discovery"],
    inputSchema: toolDiscoverySearchInputSchema, requiredPermissions: ["tools:read"], sideEffect: "read", concurrencySafe: true, visibility: "agent",
    async execute(input, context: ToolExecutionContext) { const started = Date.now(); const result = runtime.search(input, context.grantedPermissions); await runtime.emitSearch(context.sessionId, context.agentId, input.query, result, Date.now() - started); return result; },
  };
  const describe: ToolDefinition<ToolDiscoveryDescribeInput, ToolDiscoveryDescribeResult> = {
    name: "tools.describe", description: "Load complete schemas for selected tools from the catalog.", shortSummary: "Describe and load tools.", tags: ["discovery", "schema"], capabilities: ["tool-discovery"],
    inputSchema: toolDiscoveryDescribeInputSchema, requiredPermissions: ["tools:read"], sideEffect: "write", concurrencySafe: false, visibility: "agent",
    async execute(input, context: ToolExecutionContext) { const started = Date.now(); const result = runtime.describe(context.sessionId, input, context.grantedPermissions); await runtime.emitDescribe(context.sessionId, context.agentId, input.names, result, Date.now() - started); return result; },
  };
  if (!registry.has("tools.search")) registry.register(search);
  if (!registry.has("tools.describe")) registry.register(describe);
}

export function validateToolPermission(value: string): ToolPermission { return toolPermissionSchema.parse(value); }

export type DiscoveryDispatchContext = ToolDispatchContext;
