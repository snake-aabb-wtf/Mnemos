import { z } from "zod";
import {
  artifactIdSchema,
  artifactQueryOptionsSchema,
  artifactScopeSchema,
  artifactHandleSchema,
  toArtifactHandle,
  type ArtifactRecord,
  type ArtifactStore,
} from "./artifact.js";
import {
  hiddenMemoryCandidateSchema,
  type MemoryConsolidationService,
  type MemoryRememberRequest,
} from "./consolidation.js";
import { ContextManager, type PinnedContext } from "./context.js";
import type { HistoryStore, StateStore } from "./contracts.js";
import {
  memoryIdSchema,
  memoryTimelineQuerySchema,
  type MemoryService,
} from "./memory.js";
import { memoryRetrievalQuerySchema, type MemoryRetriever } from "./retrieval.js";
import { defineTool, type ToolDefinition, type ToolRegistry } from "./tool.js";

const textSchema = z.string().trim().min(1);
const emptyObjectSchema = z.object({}).strict();
const identifierSchema = z.string().trim().min(1).max(256);
const recordSchema = z.record(z.string(), z.unknown());

const historySearchInputSchema = z.object({
  query: textSchema.max(1_024),
  limit: z.number().int().min(1).max(50).default(10),
}).strict();
const historyGetInputSchema = z.object({ messageId: memoryIdSchema }).strict();
const contextPinInputSchema = z.object({ id: identifierSchema, content: z.string().min(1).max(64_000) }).strict();
const contextUnpinInputSchema = z.object({ id: identifierSchema }).strict();
const contextRequestCompactionInputSchema = z.object({ reason: z.string().trim().max(512).optional() }).strict();
const stateSetInputSchema = z.object({ state: recordSchema }).strict();
const statePatchInputSchema = z.object({ patch: recordSchema }).strict();
const artifactGetInputSchema = z.object({ id: artifactIdSchema }).strict();
const artifactReadInputSchema = z.object({
  id: artifactIdSchema,
  offset: z.number().int().nonnegative().default(0),
  /** A model cannot request an unbounded artifact read through the native runtime. */
  length: z.number().int().positive().max(64 * 1024).optional(),
}).strict();
const artifactCreateInputSchema = z.object({
  content: z.string().max(4 * 1024 * 1024),
  scope: artifactScopeSchema.default("session"),
  type: z.string().min(1).max(128),
  mimeType: z.string().min(1).max(255).optional(),
  summary: z.string().max(16_384).optional(),
  displayName: z.string().min(1).max(512).optional(),
  metadata: recordSchema.default({}),
  expiresAt: z.string().datetime().optional(),
}).strict();
const artifactDeleteInputSchema = z.object({ id: artifactIdSchema }).strict();

export interface CognitiveToolDependencies {
  memories: MemoryService;
  retriever: MemoryRetriever;
  history: HistoryStore;
  context: ContextManager;
  state: StateStore;
  artifacts: ArtifactStore;
  /** The only permitted canonical-Memory write entry point for a Visible Agent. */
  consolidation: Pick<MemoryConsolidationService, "remember">;
}

/** Registers adapters only. Existing domain services retain their own invariants and storage boundaries. */
export function registerCognitiveTools(registry: ToolRegistry, dependencies: CognitiveToolDependencies): void {
  for (const tool of createCognitiveTools(dependencies)) registry.register(tool);
}

export function createCognitiveTools(dependencies: CognitiveToolDependencies): readonly ToolDefinition[] {
  const memorySearch = defineTool({
    name: "memory.search",
    description: "Retrieve ranked long-term memories using the configured hybrid retriever.",
    inputSchema: memoryRetrievalQuerySchema,
    requiredPermissions: ["memory:read"], sideEffect: "read", concurrencySafe: true,
    async execute(input: z.input<typeof memoryRetrievalQuerySchema>, context) {
      const results = await dependencies.retriever.retrieve(input);
      const history = await dependencies.history.list(context.sessionId);
      const base = dependencies.context.build(history, "", context.sessionId);
      const budget = dependencies.context.effectiveRetrievalTokenBudget(context.sessionId, dependencies.context.buildVisible(context.sessionId, base.recentMessages, "", [], dependencies.context.getSessionToolSchemas(context.sessionId)).stats);
      return dependencies.context.packWithinTokenBudget(results, budget).items;
    },
  });
  const memoryGet = defineTool({
    name: "memory.get",
    description: "Fetch one Memory record by stable ID.",
    inputSchema: z.object({ id: memoryIdSchema }).strict(),
    requiredPermissions: ["memory:read"], sideEffect: "read", concurrencySafe: true,
    async execute(input: { id: string }) {
      return (await dependencies.memories.get(input.id)) ?? null;
    },
  });
  const memorySource = defineTool({
    name: "memory.source",
    description: "Trace a Memory record back to its canonical History evidence.",
    inputSchema: z.object({ id: memoryIdSchema }).strict(),
    requiredPermissions: ["memory:read", "history:read"], sideEffect: "read", concurrencySafe: true,
    async execute(input: { id: string }) {
      return dependencies.memories.source(input.id);
    },
  });
  const memoryTimeline = defineTool({
    name: "memory.timeline",
    description: "Read the ordered Memory timeline for an entity or tag.",
    inputSchema: memoryTimelineQuerySchema,
    requiredPermissions: ["memory:read"], sideEffect: "read", concurrencySafe: true,
    async execute(input: z.input<typeof memoryTimelineQuerySchema>) {
      return dependencies.memories.timeline(input);
    },
  });
  const memoryRemember = defineTool({
    name: "memory.remember",
    description: "Submit a Memory candidate for Hidden Agent consolidation; it never writes canonical Memory directly.",
    inputSchema: z.object({ candidate: hiddenMemoryCandidateSchema }).strict(),
    requiredPermissions: ["memory:write"], sideEffect: "write", concurrencySafe: false,
    async execute(input: { candidate: z.infer<typeof hiddenMemoryCandidateSchema> }, context) {
      const request: MemoryRememberRequest = { sessionId: context.sessionId, candidate: input.candidate };
      return dependencies.consolidation.remember(request);
    },
  });

  const historySearch = defineTool({
    name: "history.search",
    description: "Perform a basic case-insensitive lexical search over canonical History in the current session.",
    inputSchema: historySearchInputSchema,
    requiredPermissions: ["history:read"], sideEffect: "read", concurrencySafe: true,
    async execute(input: z.output<typeof historySearchInputSchema>, context) {
      const query = input.query.toLocaleLowerCase();
      const messages = await dependencies.history.list(context.sessionId);
      return messages.filter((message) => message.content.toLocaleLowerCase().includes(query)).slice(-input.limit);
    },
  });
  const historyGet = defineTool({
    name: "history.get",
    description: "Fetch one canonical History message in the current session.",
    inputSchema: historyGetInputSchema,
    requiredPermissions: ["history:read"], sideEffect: "read", concurrencySafe: true,
    async execute(input: z.infer<typeof historyGetInputSchema>, context) {
      return (await dependencies.history.get(context.sessionId, input.messageId)) ?? null;
    },
  });

  const contextInspect = defineTool({
    name: "context.inspect",
    description: "Inspect current Context budgets, session pins, and the bounded visible raw window.",
    inputSchema: emptyObjectSchema,
    requiredPermissions: ["context:read"], sideEffect: "read", concurrencySafe: true,
    async execute(_: Record<string, never>, context) {
      const history = await dependencies.history.list(context.sessionId);
      const base = dependencies.context.build(history, dependencies.context.getSessionSystemPrompt(context.sessionId), context.sessionId);
      const visible = dependencies.context.buildVisible(context.sessionId, base.recentMessages, dependencies.context.getSessionSystemPrompt(context.sessionId), [], dependencies.context.getSessionToolSchemas(context.sessionId));
      return {
        budgets: dependencies.context.budgets,
        stats: visible.stats,
        policy: dependencies.context.policyDecision(context.sessionId, visible.stats),
        pins: dependencies.context.listPins(context.sessionId),
        recentMessageIds: visible.recentMessages.map((message) => message.id),
      };
    },
  });
  const contextPin = defineTool({
    name: "context.pin",
    description: "Create or replace a session-scoped Visible Agent pin subject to the configured pin budget.",
    inputSchema: contextPinInputSchema.extend({
      ttlTurns: z.number().int().positive().max(100).optional(),
      priority: z.enum(["normal", "low"]).optional(),
    }),
    requiredPermissions: ["context:write"], sideEffect: "write", concurrencySafe: false,
    async execute(input: z.infer<typeof contextPinInputSchema> & { ttlTurns?: number; priority?: "normal" | "low" }, context) {
      const pin: PinnedContext = {
        id: input.id, content: input.content, source: "visible-agent", sessionId: context.sessionId,
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.ttlTurns === undefined ? {} : { expiresAtTurn: dependencies.context.currentTurn(context.sessionId) + input.ttlTurns }),
      };
      const previous = dependencies.context.upsertPin(pin);
      return { pin, ...(previous === undefined ? {} : { replacedPinId: previous.id }) };
    },
  });
  const contextUnpin = defineTool({
    name: "context.unpin",
    description: "Remove one session-scoped Visible Agent pin.",
    inputSchema: contextUnpinInputSchema,
    requiredPermissions: ["context:write"], sideEffect: "write", concurrencySafe: false,
    async execute(input: z.infer<typeof contextUnpinInputSchema>, context) {
      return { removed: dependencies.context.removeAgentPin(input.id, context.sessionId) };
    },
  });
  const contextRequestCompaction = defineTool({
    name: "context.request_compaction",
    description: "Request a safe runtime compaction before the next model invocation.",
    inputSchema: contextRequestCompactionInputSchema,
    requiredPermissions: ["context:write"], sideEffect: "write", concurrencySafe: false,
    async execute(input: z.infer<typeof contextRequestCompactionInputSchema>, context) {
      dependencies.context.requestCompaction(context.sessionId);
      return { requested: true, reason: input.reason };
    },
  });

  const stateGet = defineTool({
    name: "state.get",
    description: "Read mutable working State for the current session.",
    inputSchema: emptyObjectSchema,
    requiredPermissions: ["state:read"], sideEffect: "read", concurrencySafe: true,
    async execute(_: Record<string, never>, context) {
      return (await dependencies.state.get(context.sessionId)) ?? null;
    },
  });
  const stateSet = defineTool({
    name: "state.set",
    description: "Replace mutable working State for the current session.",
    inputSchema: stateSetInputSchema,
    requiredPermissions: ["state:write"], sideEffect: "write", concurrencySafe: false,
    async execute(input: z.infer<typeof stateSetInputSchema>, context) {
      return dependencies.state.set(context.sessionId, input.state);
    },
  });
  const statePatch = defineTool({
    name: "state.patch",
    description: "Merge a patch into mutable working State for the current session.",
    inputSchema: statePatchInputSchema,
    requiredPermissions: ["state:write"], sideEffect: "write", concurrencySafe: false,
    async execute(input: z.infer<typeof statePatchInputSchema>, context) {
      return dependencies.state.patch(context.sessionId, input.patch);
    },
  });

  const artifactGet = defineTool({
    name: "artifact.get",
    description: "Read Artifact metadata and a context-safe handle without loading body bytes.",
    inputSchema: artifactGetInputSchema,
    requiredPermissions: ["artifact:read"], sideEffect: "read", concurrencySafe: true,
    async execute(input: z.infer<typeof artifactGetInputSchema>) {
      const record = await dependencies.artifacts.get(input.id);
      return record === undefined ? null : publicArtifact(record);
    },
  });
  const artifactRead = defineTool({
    name: "artifact.read",
    description: "Read a bounded byte range from an Artifact. Binary reads are externally spilled before reaching model context.",
    inputSchema: artifactReadInputSchema,
    requiredPermissions: ["artifact:read"], sideEffect: "read", concurrencySafe: true,
    async execute(input: z.output<typeof artifactReadInputSchema>) {
      const record = await dependencies.artifacts.get(input.id);
      if (record === undefined) return null;
      const length = input.length ?? Math.min(64 * 1024, Math.max(0, record.sizeBytes - input.offset));
      const bytes = await dependencies.artifacts.read(input.id, { offset: input.offset, ...(length === 0 ? {} : { length }) });
      if (!isTextMime(record.mimeType)) return bytes;
      return {
        artifactId: record.id,
        offset: input.offset,
        content: new TextDecoder().decode(bytes),
        truncated: input.offset + bytes.byteLength < record.sizeBytes,
      };
    },
  });
  const artifactQuery = defineTool({
    name: "artifact.query",
    description: "Query a text Artifact locally and return bounded snippets.",
    inputSchema: z.object({ id: artifactIdSchema, options: artifactQueryOptionsSchema }).strict(),
    requiredPermissions: ["artifact:read"], sideEffect: "read", concurrencySafe: true,
    async execute(input: { id: string; options: z.input<typeof artifactQueryOptionsSchema> }) {
      return dependencies.artifacts.query(input.id, input.options);
    },
  });
  const artifactCreate = defineTool({
    name: "artifact.create",
    description: "Create a session or persistent text Artifact and return only its safe handle.",
    inputSchema: artifactCreateInputSchema,
    requiredPermissions: ["artifact:write"], sideEffect: "write", concurrencySafe: false,
    async execute(input: z.input<typeof artifactCreateInputSchema>, context) {
      const record = await dependencies.artifacts.create({
        sessionId: context.sessionId,
        scope: input.scope,
        type: input.type,
        ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        metadata: input.metadata,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        content: input.content,
      });
      return toArtifactHandle(record);
    },
  });
  const artifactDelete = defineTool({
    name: "artifact.delete",
    description: "Delete an Artifact body and metadata. This is destructive.",
    inputSchema: artifactDeleteInputSchema,
    requiredPermissions: ["artifact:delete"], sideEffect: "destructive", concurrencySafe: false,
    async execute(input: z.infer<typeof artifactDeleteInputSchema>) {
      return { deleted: await dependencies.artifacts.delete(input.id) };
    },
  });

  return [
    memorySearch, memoryGet, memorySource, memoryTimeline, memoryRemember,
    historySearch, historyGet,
    contextInspect, contextPin, contextUnpin, contextRequestCompaction,
    stateGet, stateSet, statePatch,
    artifactGet, artifactRead, artifactQuery, artifactCreate, artifactDelete,
  ];
}

function publicArtifact(record: ArtifactRecord): { handle: z.infer<typeof artifactHandleSchema>; scope: ArtifactRecord["scope"]; expiresAt?: string; displayName?: string; metadata: Record<string, unknown> } {
  return {
    handle: toArtifactHandle(record),
    scope: record.scope,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    ...(record.displayName === undefined ? {} : { displayName: record.displayName }),
    metadata: record.metadata,
  };
}

function isTextMime(mimeType: string | undefined): boolean {
  const mime = mimeType?.toLocaleLowerCase();
  return mime !== undefined && (mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json") || mime === "application/xml" || mime.endsWith("+xml"));
}
