import { z } from "zod";
import type { ArtifactHandle, ArtifactSpillService } from "./artifact.js";
import type { EventBus, HarnessEventMap } from "./events.js";
import type { ModelToolDeclaration } from "./model.js";

/**
 * `run_code` is the one root-level runtime control tool. All capability tools
 * remain namespaced, which keeps the Registry's normal ownership boundary
 * intact while giving providers a stable, conventional PTC entry point.
 */
const toolNamePattern = /^(?:run_code|[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)$/;
const toolPermissionPattern = /^[a-z][a-z0-9-]*:(?:read|write|delete|execute)$/;

export const toolNameSchema = z.string().regex(toolNamePattern, "Tool names must use a stable dotted namespace (except run_code)");
export type ToolName = z.infer<typeof toolNameSchema>;

export const toolPermissionSchema = z.string().regex(toolPermissionPattern, "Permissions must use domain:verb form");
export type ToolPermission = z.infer<typeof toolPermissionSchema>;

export const toolSideEffectSchema = z.enum(["none", "read", "write", "destructive"]);
export type ToolSideEffect = z.infer<typeof toolSideEffectSchema>;

export interface ToolMetadata {
  name: ToolName;
  description: string;
  requiredPermissions: readonly ToolPermission[];
  sideEffect: ToolSideEffect;
  /** Phase 8 can use this metadata as a concurrency/barrier hint. */
  concurrencySafe: boolean;
  /** Optional tighter execution budget than the dispatcher default. */
  timeoutMs?: number;
}

export interface ToolExecutionContext {
  readonly callId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly principal: string;
  readonly grantedPermissions: readonly ToolPermission[];
  /** Cooperative cancellation signal; tools should stop promptly when aborted. */
  readonly signal: AbortSignal;
}

/**
 * Formal Tool contract. Zod schemas remain the single source for dispatcher
 * validation and model-facing JSON Schema export.
 */
export interface ToolDefinition<TInput = unknown, TOutput = unknown> extends ToolMetadata {
  inputSchema: z.ZodTypeAny;
  outputSchema?: z.ZodTypeAny;
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
}

export function defineTool<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): ToolDefinition<TInput, TOutput> {
  return definition;
}

export interface RegisteredToolDefinition extends ToolMetadata {
  inputSchema: z.ZodTypeAny;
  outputSchema?: z.ZodTypeAny;
  execute(input: unknown, context: ToolExecutionContext): Promise<unknown>;
}

export interface ToolDescriptor extends ToolMetadata {
  inputSchema: ToolJsonSchema;
  /** Optional result contract, used by the generated PTC TypeScript SDK. */
  outputSchema?: ToolJsonSchema;
}

/** Registry owns available definitions only; it never executes them. */
export class ToolRegistry {
  private readonly definitions = new Map<ToolName, RegisteredToolDefinition>();

  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): void {
    this.validateDefinition(definition);
    const name = toolNameSchema.parse(definition.name);
    if (this.definitions.has(name)) throw new Error(`Tool already registered: ${name}`);
    this.definitions.set(name, definition as unknown as RegisteredToolDefinition);
  }

  unregister(name: string): boolean {
    return this.definitions.delete(toolNameSchema.parse(name));
  }

  get(name: string): RegisteredToolDefinition | undefined {
    return this.definitions.get(toolNameSchema.parse(name));
  }

  has(name: string): boolean {
    return this.definitions.has(toolNameSchema.parse(name));
  }

  list(): readonly ToolDescriptor[] {
    return [...this.definitions.values()]
      .map((definition) => this.descriptor(definition))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  nativeDeclarations(): readonly ModelToolDeclaration[] {
    return this.list().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  private descriptor(definition: RegisteredToolDefinition): ToolDescriptor {
    return {
      name: definition.name,
      description: definition.description,
      requiredPermissions: [...definition.requiredPermissions],
      sideEffect: definition.sideEffect,
      concurrencySafe: definition.concurrencySafe,
      ...(definition.timeoutMs === undefined ? {} : { timeoutMs: definition.timeoutMs }),
      inputSchema: zodToJsonSchema(definition.inputSchema),
      ...(definition.outputSchema === undefined ? {} : { outputSchema: zodToJsonSchema(definition.outputSchema) }),
    };
  }

  private validateDefinition(definition: ToolDefinition): void {
    toolNameSchema.parse(definition.name);
    if (definition.description.trim().length === 0) throw new Error("Tool descriptions cannot be empty");
    if (typeof definition.inputSchema?.safeParse !== "function") throw new Error(`Tool ${definition.name} requires a Zod input schema`);
    if (definition.outputSchema !== undefined && typeof definition.outputSchema.safeParse !== "function") {
      throw new Error(`Tool ${definition.name} outputSchema must be a Zod schema`);
    }
    if (typeof definition.execute !== "function") throw new Error(`Tool ${definition.name} requires an execute function`);
    if (definition.requiredPermissions.length === 0) throw new Error(`Tool ${definition.name} requires explicit permissions`);
    const permissions = definition.requiredPermissions.map((permission) => toolPermissionSchema.parse(permission));
    if (new Set(permissions).size !== permissions.length) throw new Error(`Tool ${definition.name} contains duplicate permissions`);
    toolSideEffectSchema.parse(definition.sideEffect);
    if (definition.timeoutMs !== undefined && (!Number.isInteger(definition.timeoutMs) || definition.timeoutMs <= 0)) {
      throw new Error(`Tool ${definition.name} timeoutMs must be a positive integer`);
    }
  }
}

export const toolCallSchema = z.object({
  id: z.string().trim().min(1).max(256),
  name: toolNameSchema,
  arguments: z.unknown(),
}).strict();
export type ToolCall = z.infer<typeof toolCallSchema>;

export const toolExecutionErrorSchema = z.object({
  code: z.enum([
    "tool_not_found",
    "permission_denied",
    "invalid_arguments",
    "timeout",
    "invalid_output",
    "output_too_large",
    "execution_failed",
  ]),
  /** Safe, model-visible summary. Internal errors are reported out of band only. */
  message: z.string().min(1),
  retryable: z.boolean(),
}).strict();
export type ToolExecutionError = z.infer<typeof toolExecutionErrorSchema>;

export interface InlineToolOutput {
  kind: "inline";
  value: unknown;
  serializedBytes: number;
}

export interface ArtifactToolOutput {
  kind: "artifact";
  handle: ArtifactHandle;
  serializedBytes: number;
}

export type NormalizedToolOutput = InlineToolOutput | ArtifactToolOutput;

export interface ToolSuccessResult {
  status: "success";
  callId: string;
  toolName: ToolName;
  durationMs: number;
  output: NormalizedToolOutput;
}

export interface ToolFailureResult {
  status: "error";
  callId: string;
  toolName: string;
  durationMs: number;
  error: ToolExecutionError;
}

export type ToolResult = ToolSuccessResult | ToolFailureResult;

export interface ToolDispatchContext {
  sessionId: string;
  agentId: string;
  principal: string;
  /** Supplied by the host/runtime, never by model-generated ToolCall arguments. */
  grantedPermissions: readonly ToolPermission[];
}

export interface ToolOutputPolicy {
  maxInlineBytes: number;
  spillThresholdBytes: number;
  maxModelVisibleBytes: number;
}

export const defaultToolOutputPolicy: ToolOutputPolicy = {
  maxInlineBytes: 16 * 1024,
  spillThresholdBytes: 64 * 1024,
  maxModelVisibleBytes: 64 * 1024,
};

export const toolOutputPolicySchema = z.object({
  maxInlineBytes: z.number().int().nonnegative(),
  spillThresholdBytes: z.number().int().positive(),
  maxModelVisibleBytes: z.number().int().positive(),
});

export interface ToolAuditEntry {
  callId: string;
  toolName: string;
  sessionId: string;
  agentId: string;
  principal: string;
  startedAt: string;
  durationMs: number;
  status: "success" | "error" | "denied";
  errorCode?: ToolExecutionError["code"];
  outputKind?: NormalizedToolOutput["kind"];
  spilled?: boolean;
}

export interface ToolAuditStore {
  append(entry: ToolAuditEntry): Promise<void>;
  list(filter?: { sessionId?: string; callId?: string; limit?: number }): Promise<readonly ToolAuditEntry[]>;
}

/** Small replaceable baseline; a host can provide durable SQLite audit storage later. */
export class InMemoryToolAuditStore implements ToolAuditStore {
  private readonly entries: ToolAuditEntry[] = [];

  async append(entry: ToolAuditEntry): Promise<void> {
    this.entries.push({ ...entry });
  }

  async list(filter: { sessionId?: string; callId?: string; limit?: number } = {}): Promise<readonly ToolAuditEntry[]> {
    const limit = filter.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 0) throw new Error("Audit limit must be a non-negative integer");
    return this.entries
      .filter((entry) => (filter.sessionId === undefined || entry.sessionId === filter.sessionId)
        && (filter.callId === undefined || entry.callId === filter.callId))
      .slice(-limit)
      .map((entry) => ({ ...entry }));
  }
}

export interface ToolDispatcherOptions {
  registry: ToolRegistry;
  artifactSpill?: ArtifactSpillService;
  outputPolicy?: Partial<ToolOutputPolicy>;
  defaultToolTimeoutMs?: number;
  events?: EventBus<HarnessEventMap>;
  audit?: ToolAuditStore;
  /** Receives internal details without exposing errors or stacks to the model. */
  onInternalError?: (error: Error, call: { callId: string; toolName: string }) => void;
}

class ToolTimeoutError extends Error {}
class ToolOutputTooLargeError extends Error {}
class ToolOutputSerializationError extends Error {}

/** The sole execution gate for native and future PTC tool calls. */
export class ToolDispatcher {
  readonly outputPolicy: ToolOutputPolicy;
  readonly defaultToolTimeoutMs: number;
  private readonly audit: ToolAuditStore;

  constructor(private readonly options: ToolDispatcherOptions) {
    this.outputPolicy = toolOutputPolicySchema.parse({ ...defaultToolOutputPolicy, ...options.outputPolicy });
    this.defaultToolTimeoutMs = options.defaultToolTimeoutMs ?? 30_000;
    if (!Number.isInteger(this.defaultToolTimeoutMs) || this.defaultToolTimeoutMs <= 0) {
      throw new Error("defaultToolTimeoutMs must be a positive integer");
    }
    this.audit = options.audit ?? new InMemoryToolAuditStore();
  }

  async dispatch(rawCall: ToolCall, context: ToolDispatchContext): Promise<ToolResult> {
    const startedAt = new Date();
    const startedMs = startedAt.getTime();
    const candidateCallId = typeof (rawCall as { id?: unknown }).id === "string" && (rawCall as { id: string }).id.trim() !== ""
      ? (rawCall as { id: string }).id
      : "invalid-call";
    const candidateName = typeof (rawCall as { name?: unknown }).name === "string" ? (rawCall as { name: string }).name : "unknown";
    const parsedCall = toolCallSchema.safeParse(rawCall);
    if (!parsedCall.success) {
      return this.failure(candidateCallId, candidateName, context, startedAt, startedMs, {
        code: "invalid_arguments", message: "Tool call is malformed.", retryable: false,
      });
    }
    const call = parsedCall.data;
    const tool = this.options.registry.get(call.name);
    if (!tool) {
      return this.failure(call.id, call.name, context, startedAt, startedMs, {
        code: "tool_not_found", message: `Unknown tool: ${call.name}.`, retryable: false,
      });
    }
    if (!this.isPermitted(tool, context)) {
      const result = await this.failure(call.id, call.name, context, startedAt, startedMs, {
        code: "permission_denied", message: "This tool is not permitted for the current principal.", retryable: false,
      }, "denied");
      await this.emit("tool.denied", {
        callId: call.id, toolName: call.name, sessionId: context.sessionId, agentId: context.agentId,
        durationMs: result.durationMs, status: "denied", errorCode: "permission_denied",
      });
      return result;
    }
    const input = tool.inputSchema.safeParse(call.arguments);
    if (!input.success) {
      return this.failure(call.id, call.name, context, startedAt, startedMs, {
        code: "invalid_arguments", message: "Tool arguments do not match the required schema.", retryable: false,
      });
    }

    await this.emit("tool.called", {
      callId: call.id, toolName: call.name, sessionId: context.sessionId, agentId: context.agentId,
      status: "called",
    });
    try {
      const output = await this.executeWithTimeout(tool, input.data, call, context);
      let normalizedValue = output;
      if (tool.outputSchema !== undefined) {
        const validatedOutput = tool.outputSchema.safeParse(output);
        if (!validatedOutput.success) throw new ToolOutputSerializationError("Tool output does not match its declared schema");
        normalizedValue = validatedOutput.data;
      }
      const normalized = await this.normalizeOutput(normalizedValue, call, context);
      const result: ToolSuccessResult = {
        status: "success",
        callId: call.id,
        toolName: call.name,
        durationMs: Date.now() - startedMs,
        output: normalized,
      };
      await this.record({
        callId: call.id, toolName: call.name, sessionId: context.sessionId, agentId: context.agentId, principal: context.principal,
        startedAt: startedAt.toISOString(), durationMs: result.durationMs, status: "success", outputKind: normalized.kind,
        spilled: normalized.kind === "artifact",
      });
      await this.emit("tool.completed", {
        callId: call.id, toolName: call.name, sessionId: context.sessionId, agentId: context.agentId,
        durationMs: result.durationMs, status: "success", outputKind: normalized.kind,
      });
      if (normalized.kind === "artifact") {
        await this.emit("tool.output.spilled", {
          callId: call.id, toolName: call.name, sessionId: context.sessionId, agentId: context.agentId,
          durationMs: result.durationMs, status: "success", handle: normalized.handle, serializedBytes: normalized.serializedBytes,
        });
      }
      return result;
    } catch (error) {
      const executionError = this.toPublicError(error, call);
      this.report(error, call);
      return this.failure(call.id, call.name, context, startedAt, startedMs, executionError);
    }
  }

  private async executeWithTimeout(
    tool: RegisteredToolDefinition,
    input: unknown,
    call: ToolCall,
    context: ToolDispatchContext,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeoutMs = tool.timeoutMs ?? this.defaultToolTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ToolTimeoutError(`Tool exceeded ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => tool.execute(input, {
          callId: call.id,
          sessionId: context.sessionId,
          agentId: context.agentId,
          principal: context.principal,
          grantedPermissions: [...context.grantedPermissions],
          signal: controller.signal,
        })),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async normalizeOutput(output: unknown, call: ToolCall, context: ToolDispatchContext): Promise<NormalizedToolOutput> {
    const binary = output instanceof Uint8Array;
    let content: string | Uint8Array;
    let serializedBytes: number;
    let mimeType: string;
    if (binary) {
      content = output;
      serializedBytes = output.byteLength;
      mimeType = "application/octet-stream";
    } else {
      try {
        const serialized = JSON.stringify(output);
        if (serialized === undefined) throw new Error("undefined is not JSON");
        content = serialized;
      } catch (error) {
        throw new ToolOutputSerializationError(error instanceof Error ? error.message : "Unable to serialize tool output");
      }
      serializedBytes = Buffer.byteLength(content);
      mimeType = "application/json";
    }
    const inlineLimit = Math.min(
      this.outputPolicy.maxInlineBytes,
      this.outputPolicy.spillThresholdBytes,
      this.outputPolicy.maxModelVisibleBytes,
    );
    if (!binary && serializedBytes <= inlineLimit) {
      return { kind: "inline", value: output, serializedBytes };
    }
    if (!this.options.artifactSpill) throw new ToolOutputTooLargeError("No Artifact spill service is configured");
    const spilled = await this.options.artifactSpill.spill({
      sessionId: context.sessionId,
      type: "tool-output",
      mimeType,
      summary: `Output from ${call.name}`,
      metadata: { toolName: call.name, callId: call.id },
      content,
    }, { forceArtifact: true });
    if (spilled.kind !== "artifact") throw new ToolOutputTooLargeError("Artifact spill did not produce a handle");
    return { kind: "artifact", handle: spilled.handle, serializedBytes };
  }

  private isPermitted(tool: RegisteredToolDefinition, context: ToolDispatchContext): boolean {
    try {
      const granted = new Set(context.grantedPermissions.map((permission) => toolPermissionSchema.parse(permission)));
      return tool.requiredPermissions.every((permission) => granted.has(permission));
    } catch {
      // Invalid host grants never become an execution-time privilege escalation.
      return false;
    }
  }

  private async failure(
    callId: string,
    toolName: string,
    context: ToolDispatchContext,
    startedAt: Date,
    startedMs: number,
    error: ToolExecutionError,
    auditStatus: "error" | "denied" = "error",
  ): Promise<ToolFailureResult> {
    const result: ToolFailureResult = {
      status: "error", callId, toolName, durationMs: Date.now() - startedMs, error: toolExecutionErrorSchema.parse(error),
    };
    await this.record({
      callId, toolName, sessionId: context.sessionId, agentId: context.agentId, principal: context.principal,
      startedAt: startedAt.toISOString(), durationMs: result.durationMs, status: auditStatus, errorCode: result.error.code,
    });
    await this.emit("tool.failed", {
      callId, toolName, sessionId: context.sessionId, agentId: context.agentId,
      durationMs: result.durationMs, status: "error", errorCode: result.error.code,
    });
    return result;
  }

  private toPublicError(error: unknown, call: ToolCall): ToolExecutionError {
    if (error instanceof ToolTimeoutError) return { code: "timeout", message: "Tool execution timed out.", retryable: true };
    if (error instanceof ToolOutputTooLargeError) return { code: "output_too_large", message: "Tool output is too large to return inline.", retryable: false };
    if (error instanceof ToolOutputSerializationError) return { code: "invalid_output", message: "Tool returned an unsupported output.", retryable: false };
    return { code: "execution_failed", message: `Tool ${call.name} could not complete.`, retryable: true };
  }

  private async record(entry: ToolAuditEntry): Promise<void> {
    try {
      await this.audit.append(entry);
    } catch (error) {
      this.report(error, { id: entry.callId, name: entry.toolName });
    }
  }

  private async emit<K extends keyof HarnessEventMap>(event: K, payload: HarnessEventMap[K]): Promise<void> {
    if (!this.options.events) return;
    try {
      await this.options.events.emit(event, payload);
    } catch (error) {
      this.report(error, { id: "event", name: String(event) });
    }
  }

  private report(error: unknown, call: Pick<ToolCall, "id" | "name">): void {
    const internal = error instanceof Error ? error : new Error(String(error));
    this.options.onInternalError?.(internal, { callId: call.id, toolName: call.name });
  }
}

/** JSON Schema subset required by provider-neutral native tool declarations. */
export interface ToolJsonSchema {
  [key: string]: unknown;
}

/**
 * Zod v3 has no built-in JSON Schema exporter. This intentionally small,
 * deterministic converter covers the Zod forms used by Mnemos tool contracts
 * while preserving Zod as the only authored schema.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny, seen = new Set<z.ZodTypeAny>()): ToolJsonSchema {
  if (seen.has(schema)) return {};
  const nextSeen = new Set(seen).add(schema);
  const definition = schema._def as Record<string, unknown>;
  const typeName = definition.typeName as z.ZodFirstPartyTypeKind;
  switch (typeName) {
    case z.ZodFirstPartyTypeKind.ZodString: {
      const result: ToolJsonSchema = { type: "string" };
      for (const check of (definition.checks as Array<Record<string, unknown>> ?? [])) {
        if (check.kind === "min") result.minLength = check.value;
        if (check.kind === "max") result.maxLength = check.value;
        if (check.kind === "email") result.format = "email";
        if (check.kind === "uuid") result.format = "uuid";
      }
      return result;
    }
    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const result: ToolJsonSchema = { type: "number" };
      for (const check of (definition.checks as Array<Record<string, unknown>> ?? [])) {
        if (check.kind === "int") result.type = "integer";
        if (check.kind === "min") result[check.inclusive === false ? "exclusiveMinimum" : "minimum"] = check.value;
        if (check.kind === "max") result[check.inclusive === false ? "exclusiveMaximum" : "maximum"] = check.value;
      }
      return result;
    }
    case z.ZodFirstPartyTypeKind.ZodBoolean: return { type: "boolean" };
    case z.ZodFirstPartyTypeKind.ZodNull: return { type: "null" };
    case z.ZodFirstPartyTypeKind.ZodLiteral: return { const: definition.value };
    case z.ZodFirstPartyTypeKind.ZodEnum: return { type: "string", enum: definition.values };
    case z.ZodFirstPartyTypeKind.ZodNativeEnum: return { enum: Object.values(definition.values as object) };
    case z.ZodFirstPartyTypeKind.ZodArray: return { type: "array", items: zodToJsonSchema(definition.type as z.ZodTypeAny, nextSeen) };
    case z.ZodFirstPartyTypeKind.ZodTuple: return {
      type: "array",
      prefixItems: (definition.items as z.ZodTypeAny[]).map((item) => zodToJsonSchema(item, nextSeen)),
      ...(definition.rest === null ? {} : { items: zodToJsonSchema(definition.rest as z.ZodTypeAny, nextSeen) }),
    };
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (definition.shape as () => Record<string, z.ZodTypeAny>)();
      const properties = Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, zodToJsonSchema(value, nextSeen)]));
      const required = Object.entries(shape).filter(([, value]) => !value.isOptional()).map(([key]) => key);
      return {
        type: "object",
        properties,
        ...(required.length === 0 ? {} : { required }),
        additionalProperties: definition.unknownKeys === "passthrough",
      };
    }
    case z.ZodFirstPartyTypeKind.ZodRecord: return {
      type: "object",
      additionalProperties: zodToJsonSchema(definition.valueType as z.ZodTypeAny, nextSeen),
    };
    case z.ZodFirstPartyTypeKind.ZodUnion: return { anyOf: (definition.options as z.ZodTypeAny[]).map((option) => zodToJsonSchema(option, nextSeen)) };
    case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion: return {
      oneOf: [...(definition.options as Map<string, z.ZodTypeAny>).values()].map((option) => zodToJsonSchema(option, nextSeen)),
    };
    case z.ZodFirstPartyTypeKind.ZodNullable: return { anyOf: [zodToJsonSchema(definition.innerType as z.ZodTypeAny, nextSeen), { type: "null" }] };
    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodDefault:
    case z.ZodFirstPartyTypeKind.ZodCatch:
    case z.ZodFirstPartyTypeKind.ZodBranded:
      return zodToJsonSchema(definition.innerType as z.ZodTypeAny, nextSeen);
    case z.ZodFirstPartyTypeKind.ZodEffects:
      return zodToJsonSchema(definition.schema as z.ZodTypeAny, nextSeen);
    case z.ZodFirstPartyTypeKind.ZodPipeline:
      return zodToJsonSchema(definition.out as z.ZodTypeAny, nextSeen);
    case z.ZodFirstPartyTypeKind.ZodLazy:
      return zodToJsonSchema((definition.getter as () => z.ZodTypeAny)(), nextSeen);
    case z.ZodFirstPartyTypeKind.ZodDate: return { type: "string", format: "date-time" };
    default: return {};
  }
}
