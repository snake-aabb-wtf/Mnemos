import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ArtifactHandle, ArtifactSpillService } from "./artifact.js";
import type { EventBus, HarnessEventMap } from "./events.js";
import {
  defineTool,
  type RegisteredToolDefinition,
  type ToolDefinition,
  type ToolDispatchContext,
  ToolDispatcher,
  type ToolExecutionContext,
  type ToolJsonSchema,
  type ToolRegistry,
  type ToolResult,
} from "./tool.js";

export const runCodeToolName = "run_code" as const;

export const ptcLanguageSchema = z.enum(["typescript", "javascript"]);
export type PtcLanguage = z.infer<typeof ptcLanguageSchema>;

export const runCodeInputSchema = z.object({
  code: z.string().min(1).max(256 * 1024),
  language: ptcLanguageSchema.default("typescript"),
  /** A caller may request a smaller limit, never a larger one. */
  timeoutMs: z.number().int().positive().max(10 * 60_000).optional(),
}).strict();
export type RunCodeInput = z.input<typeof runCodeInputSchema>;

export type ToolExecutionMode = "native" | "ptc" | "both";
export const toolExecutionModeSchema = z.enum(["native", "ptc", "both"]);

export interface PtcPolicy {
  maxExecutionMs: number;
  maxMemoryMb: number;
  maxToolCalls: number;
  maxConcurrentToolCalls: number;
  /** Maximum final result retained inline for the next Visible Agent turn. */
  maxReturnedBytes: number;
  /** Upper bound for the child-to-host JSON result transport. */
  maxSandboxResultBytes: number;
  /** Bounds one SDK RPC payload before it reaches the host Dispatcher. */
  maxToolArgumentBytes: number;
  maxLogBytes: number;
}

export const defaultPtcPolicy: PtcPolicy = {
  maxExecutionMs: 15_000,
  maxMemoryMb: 96,
  maxToolCalls: 100,
  maxConcurrentToolCalls: 8,
  maxReturnedBytes: 32 * 1024,
  maxSandboxResultBytes: 8 * 1024 * 1024,
  maxToolArgumentBytes: 512 * 1024,
  maxLogBytes: 16 * 1024,
};

const ptcPolicySchema = z.object({
  maxExecutionMs: z.number().int().positive().max(10 * 60_000),
  maxMemoryMb: z.number().int().min(16).max(4_096),
  maxToolCalls: z.number().int().positive().max(10_000),
  maxConcurrentToolCalls: z.number().int().positive().max(128),
  maxReturnedBytes: z.number().int().positive().max(16 * 1024 * 1024),
  maxSandboxResultBytes: z.number().int().positive().max(64 * 1024 * 1024),
  maxToolArgumentBytes: z.number().int().positive().max(16 * 1024 * 1024),
  maxLogBytes: z.number().int().positive().max(4 * 1024 * 1024),
}).superRefine((policy, context) => {
  if (policy.maxReturnedBytes > policy.maxSandboxResultBytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "maxReturnedBytes cannot exceed maxSandboxResultBytes" });
  }
});

export type PtcErrorCode =
  | "source_invalid"
  | "execution_timeout"
  | "execution_cancelled"
  | "memory_limit"
  | "tool_call_quota_exceeded"
  | "return_too_large"
  | "serialization_failed"
  | "log_limit_exceeded"
  | "sandbox_crashed"
  | "execution_failed";

export interface PtcExecutionError {
  code: PtcErrorCode;
  message: string;
  retryable: boolean;
}

export interface PtcExecutionStats {
  durationMs: number;
  toolCalls: number;
  peakConcurrency: number;
  logBytes: number;
  logsTruncated: boolean;
}

/**
 * JSON-only result of a PTC invocation. It is intentionally independent from
 * ToolResult: run_code itself is a normal Tool, while this describes its
 * internal program lifecycle.
 */
export type PtcExecutionResult =
  | {
    status: "success";
    result: unknown;
    artifacts: readonly ArtifactHandle[];
    stats: PtcExecutionStats;
  }
  | {
    status: "error";
    error: PtcExecutionError;
    artifacts: readonly ArtifactHandle[];
    stats: PtcExecutionStats;
  };

export const ptcExecutionResultSchema = z.object({
  status: z.enum(["success", "error"]),
  result: z.unknown().optional(),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
  }).optional(),
  artifacts: z.array(z.object({
    id: z.string(),
    type: z.string(),
    mimeType: z.string().optional(),
    sizeBytes: z.number(),
    sha256: z.string(),
    summary: z.string().optional(),
  })),
  stats: z.object({
    durationMs: z.number().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    peakConcurrency: z.number().int().nonnegative(),
    logBytes: z.number().int().nonnegative(),
    logsTruncated: z.boolean(),
  }),
}).strict();

export interface PtcSdkTool {
  name: string;
  description: string;
  inputSchema: ToolJsonSchema;
  outputSchema?: ToolJsonSchema;
}

export interface PtcSdkDescription {
  declarations: string;
  tools: readonly PtcSdkTool[];
}

/**
 * One Registry-derived contract powers native model declarations, dispatcher
 * validation, and the PTC declarations. The SDK contains no implementation
 * references and is safe to expose to a model.
 */
export class PtcSdkGenerator {
  constructor(private readonly registry: ToolRegistry) {}

  describe(allowedToolNames?: readonly string[]): PtcSdkDescription {
    const allowed = allowedToolNames === undefined ? undefined : new Set(allowedToolNames);
    const tools = this.registry.list()
      .filter((tool) => tool.name !== runCodeToolName && (allowed === undefined || allowed.has(tool.name)))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      }));
    return { tools, declarations: this.declarations(tools) };
  }

  private declarations(tools: readonly PtcSdkTool[]): string {
    const tree: Record<string, unknown> = {};
    for (const tool of tools) {
      const parts = tool.name.split(".");
      let cursor = tree;
      for (const part of parts.slice(0, -1)) {
        const existing = cursor[part];
        if (existing === undefined) cursor[part] = {};
        cursor = cursor[part] as Record<string, unknown>;
      }
      cursor[parts.at(-1) ?? tool.name] = tool;
    }
    return [
      "declare class ToolError extends Error { readonly code: string; readonly retryable: boolean; }",
      "declare const tools: " + this.renderTree(tree, 0) + ";",
      "The program body is async. Do not import modules; use only tools.* for external capabilities.",
    ].join("\n");
  }

  private renderTree(tree: Record<string, unknown>, indent: number): string {
    const pad = "  ".repeat(indent);
    const lines = ["{"];
    for (const [key, value] of Object.entries(tree).sort(([left], [right]) => left.localeCompare(right))) {
      if (this.isSdkTool(value)) {
        lines.push(pad + "  readonly " + key + ": (input: " + jsonSchemaToType(value.inputSchema)
          + ") => Promise<" + jsonSchemaToType(value.outputSchema ?? {}) + ">;");
      } else {
        lines.push(pad + "  readonly " + key + ": " + this.renderTree(value as Record<string, unknown>, indent + 1) + ";");
      }
    }
    lines.push(pad + "}");
    return lines.join("\n");
  }

  private isSdkTool(value: unknown): value is PtcSdkTool {
    return typeof value === "object" && value !== null && "inputSchema" in value && "name" in value;
  }
}

function jsonSchemaToType(schema: ToolJsonSchema): string {
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const options = (schema.anyOf ?? schema.oneOf) as ToolJsonSchema[];
    return options.map(jsonSchemaToType).join(" | ");
  }
  if (schema.type === "array") return "Array<" + jsonSchemaToType((schema.items ?? {}) as ToolJsonSchema) + ">";
  if (schema.type === "object") {
    const properties = (schema.properties ?? {}) as Record<string, ToolJsonSchema>;
    const required = new Set((schema.required ?? []) as string[]);
    return "{ " + Object.entries(properties).map(([name, property]) =>
      JSON.stringify(name) + (required.has(name) ? "" : "?") + ": " + jsonSchemaToType(property),
    ).join("; ") + " }";
  }
  if (schema.type === "string") return "string";
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "null") return "null";
  return "unknown";
}

export const PTC_POLICY_VERSION = "ptc-policy/v1";

/**
 * Kept in one versioned module rather than scattered among provider adapters.
 * The catalog is included in context accounting by Harness, so it is never
 * treated as free prompt space.
 */
export function ptcModelInstructions(sdk: PtcSdkDescription): readonly string[] {
  return [
    PTC_POLICY_VERSION,
    "Use a native tool for one simple action. Use run_code for multi-step search, filtering, aggregation, loops, or independent read calls.",
    "In run_code, external capabilities exist only through tools.*. Do not import modules and do not assume filesystem, network, environment, or process access.",
    "Filter and aggregate inside the program. Return only the smallest useful final result; large intermediate results remain in the PTC runtime.",
    "Independent read-only calls may use Promise.all. Tool permissions are supplied by the host and cannot be changed by code.",
    "Generated TypeScript SDK declarations:\n" + sdk.declarations,
  ];
}

export interface PtcToolCallRequest {
  requestId: string;
  toolName: string;
  argumentsJson: string;
}

export type PtcToolCallHandler = (request: PtcToolCallRequest) => Promise<PtcToolRpcResponse>;

export type PtcToolRpcResponse =
  | { ok: true; output: { kind: "inline"; valueJson: string } | { kind: "artifact"; handle: ArtifactHandle } }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

export interface PtcExecutionRequest {
  executionId: string;
  code: string;
  language: PtcLanguage;
  policy: PtcPolicy;
  sdk: PtcSdkDescription;
  signal?: AbortSignal;
  onToolCall: PtcToolCallHandler;
}

export interface PtcSandboxExecutionResult {
  status: "success" | "error";
  resultJson?: string;
  resultBytes?: number;
  error?: PtcExecutionError;
  logBytes: number;
  logsTruncated: boolean;
}

/** A replaceable execution boundary. Phase 13 can provide a container or VM backend. */
export interface PtcSandbox {
  execute(request: PtcExecutionRequest): Promise<PtcSandboxExecutionResult>;
}

interface ChildToolCallMessage {
  type: "tool-call";
  requestId: string;
  toolName: string;
  argumentsJson: string;
}

interface ChildCompletedMessage {
  type: "completed";
  resultJson: string;
  resultBytes: number;
  logBytes: number;
  logsTruncated: boolean;
}

interface ChildFailedMessage {
  type: "failed";
  error: { code: PtcErrorCode; message: string; retryable: boolean };
  logBytes: number;
  logsTruncated: boolean;
}

type ChildMessage = ChildToolCallMessage | ChildCompletedMessage | ChildFailedMessage;

/**
 * Process-per-invocation backend. Node permission mode makes filesystem, child
 * process, worker, addon, and WASI capability deny-by-default; an empty
 * environment and an RPC-only SDK further reduce ambient authority.
 *
 * Node currently has no general OS network deny switch. The host source policy
 * rejects network and import APIs, but this remains a development sandbox, not
 * a hostile-code production boundary.
 */
export class NodeProcessPtcSandbox implements PtcSandbox {
  async execute(request: PtcExecutionRequest): Promise<PtcSandboxExecutionResult> {
    const scratchDirectory = await mkdtemp(join(tmpdir(), "mnemos-ptc-"));
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [
        "--permission",
        "--disable-warning=ExperimentalWarning",
        "--max-old-space-size=" + String(request.policy.maxMemoryMb),
        "-e",
        PTC_CHILD_BOOTSTRAP,
      ], {
        cwd: scratchDirectory,
        env: {},
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      });
    } catch {
      await rm(scratchDirectory, { recursive: true, force: true });
      return sandboxError("sandbox_crashed", "The PTC sandbox could not start.", false);
    }

    return new Promise<PtcSandboxExecutionResult>((resolve) => {
      let completed = false;
      let timedOut = false;
      let outputLimitExceeded = false;
      let stderrLimitExceeded = false;
      let stderr = "";
      let outputBytes = 0;
      const finish = (result: PtcSandboxExecutionResult, terminate = true): void => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abort);
        if (terminate && child.exitCode === null && !child.killed) child.kill();
        void (async () => {
          // Windows keeps cwd handles open until the child has actually
          // exited. Wait before removal so isolated invocations do not leak
          // temporary directories or produce unhandled EBUSY rejections.
          if (child.exitCode === null) await new Promise<void>((done) => child.once("exit", () => done()));
          try {
            await rm(scratchDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
          } catch {
            // Cleanup failures never revive a completed sandbox or leak a
            // host error into model-visible output. The directory is empty.
          }
          resolve(result);
        })();
      };
      const abort = (): void => {
        finish(sandboxError("execution_cancelled", "PTC execution was cancelled by the host.", true));
      };
      const timer = setTimeout(() => {
        timedOut = true;
        finish(sandboxError("execution_timeout", "PTC execution exceeded its wall-clock limit.", true));
      }, request.policy.maxExecutionMs);
      request.signal?.addEventListener("abort", abort, { once: true });

      const consumeOutput = (chunk: Buffer): void => {
        outputBytes += chunk.byteLength;
        if (outputBytes > request.policy.maxLogBytes) {
          outputLimitExceeded = true;
          finish(sandboxError("log_limit_exceeded", "PTC sandbox output exceeded its log limit.", false));
        }
      };
      child.stdout?.on("data", consumeOutput);
      child.stderr?.on("data", (chunk: Buffer) => {
        if (completed) return;
        stderr = (stderr + chunk.toString("utf8")).slice(-8 * 1024);
        if (/heap out of memory|reached heap limit/i.test(stderr)) {
          finish(sandboxError("memory_limit", "PTC sandbox exceeded its memory budget.", false));
          return;
        }
        // Fatal V8 memory diagnostics can arrive in several stderr chunks. Do
        // not resolve as a log-limit error on the first chunk; retain the
        // bounded tail, terminate the child, and let the exit handler classify
        // a later OOM marker as memory_limit.
        outputBytes += chunk.byteLength;
        if (outputBytes > request.policy.maxLogBytes) {
          stderrLimitExceeded = true;
          if (child.exitCode === null && !child.killed) child.kill();
        }
      });
      child.on("error", () => {
        finish(sandboxError("sandbox_crashed", "The PTC sandbox process failed.", true));
      });
      child.on("exit", () => {
        if (completed || timedOut) return;
        const code: PtcErrorCode = /heap out of memory|reached heap limit/i.test(stderr)
          ? "memory_limit"
          : stderrLimitExceeded || outputLimitExceeded ? "log_limit_exceeded" : "sandbox_crashed";
        finish(sandboxError(code, code === "memory_limit"
          ? "PTC sandbox exceeded its memory budget."
          : code === "log_limit_exceeded"
            ? "PTC sandbox output exceeded its log limit."
          : "PTC sandbox exited unexpectedly.", false), false);
      });
      child.on("message", (message: unknown) => {
        if (!isChildMessage(message) || completed) return;
        if (message.type === "tool-call") {
          void request.onToolCall({
            requestId: message.requestId,
            toolName: message.toolName,
            argumentsJson: message.argumentsJson,
          }).then((response) => {
            if (completed) return;
            if (!response.ok && response.error.code === "tool_call_quota_exceeded") {
              finish({
                status: "error",
                error: { code: "tool_call_quota_exceeded", message: response.error.message, retryable: false },
                logBytes: 0,
                logsTruncated: false,
              });
              return;
            }
            if (child.connected) child.send({ type: "tool-result", requestId: message.requestId, ...response });
          }).catch(() => {
            if (!completed && child.connected) child.send({
              type: "tool-result",
              requestId: message.requestId,
              ok: false,
              error: { code: "execution_failed", message: "The tool runtime could not complete this request.", retryable: true },
            });
          });
          return;
        }
        if (message.type === "completed") {
          finish({
            status: "success",
            resultJson: message.resultJson,
            resultBytes: message.resultBytes,
            logBytes: message.logBytes,
            logsTruncated: message.logsTruncated,
          });
          return;
        }
        finish({
          status: "error",
          error: message.error,
          logBytes: message.logBytes,
          logsTruncated: message.logsTruncated,
        });
      });
      try {
        child.send({
          type: "execute",
          code: request.code,
          maxSandboxResultBytes: request.policy.maxSandboxResultBytes,
          maxToolArgumentBytes: request.policy.maxToolArgumentBytes,
          maxLogBytes: request.policy.maxLogBytes,
        });
      } catch {
        finish(sandboxError("sandbox_crashed", "The PTC sandbox IPC channel failed.", false));
      }
    });
  }
}

function isChildMessage(value: unknown): value is ChildMessage {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function sandboxError(code: PtcErrorCode, message: string, retryable: boolean): PtcSandboxExecutionResult {
  return { status: "error", error: { code, message, retryable }, logBytes: 0, logsTruncated: false };
}

class Deferred {
  readonly promise: Promise<void>;
  private resolvePromise!: () => void;

  constructor() {
    this.promise = new Promise<void>((resolve) => { this.resolvePromise = resolve; });
  }

  resolve(): void {
    this.resolvePromise();
  }
}

class AsyncSemaphore {
  private active = 0;
  private readonly queued: Array<() => void> = [];

  constructor(private readonly limit: number, private readonly onActive: (active: number) => void) {}

  async use<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.queued.push(resolve));
    this.active += 1;
    this.onActive(this.active);
  }

  private release(): void {
    this.active -= 1;
    const next = this.queued.shift();
    next?.();
  }
}

/**
 * Host-only scheduling. Safe reads can overlap; writes, destructive calls, and
 * explicitly non-concurrency-safe definitions form a barrier around reads.
 */
export class PtcToolScheduler {
  private readonly semaphore: AsyncSemaphore;
  private readonly activeReads = new Set<Promise<void>>();
  private writeTail: Promise<void> = Promise.resolve();
  private calls = 0;
  private peak = 0;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly dispatcher: ToolDispatcher,
    private readonly context: ToolDispatchContext,
    private readonly policy: PtcPolicy,
    private readonly executionId: string,
  ) {
    this.semaphore = new AsyncSemaphore(policy.maxConcurrentToolCalls, (active) => {
      this.peak = Math.max(this.peak, active);
    });
  }

  get toolCalls(): number {
    return this.calls;
  }

  get peakConcurrency(): number {
    return this.peak;
  }

  async invoke(request: PtcToolCallRequest): Promise<PtcToolRpcResponse> {
    if (this.calls >= this.policy.maxToolCalls) {
      return { ok: false, error: { code: "tool_call_quota_exceeded", message: "PTC tool call quota exceeded.", retryable: false } };
    }
    const callSequence = this.calls + 1;
    this.calls = callSequence;
    if (Buffer.byteLength(request.argumentsJson) > this.policy.maxToolArgumentBytes) {
      return { ok: false, error: { code: "invalid_arguments", message: "PTC tool arguments exceed the configured limit.", retryable: false } };
    }
    let argumentsValue: unknown;
    try {
      argumentsValue = JSON.parse(request.argumentsJson) as unknown;
    } catch {
      return { ok: false, error: { code: "invalid_arguments", message: "Tool arguments must be JSON-serializable.", retryable: false } };
    }
    const tool = this.getTool(request.toolName);
    const dispatch = async (): Promise<PtcToolRpcResponse> => this.toRpcResponse(await this.dispatcher.dispatch({
      id: this.executionId + ":" + String(callSequence) + ":" + request.requestId,
      name: request.toolName,
      arguments: argumentsValue,
    }, this.context));
    if (this.isConcurrencySafeRead(tool)) return this.runRead(dispatch);
    return this.runBarrier(dispatch);
  }

  private getTool(name: string): RegisteredToolDefinition | undefined {
    try {
      return this.registry.get(name);
    } catch {
      return undefined;
    }
  }

  private isConcurrencySafeRead(tool: RegisteredToolDefinition | undefined): boolean {
    return tool !== undefined && tool.concurrencySafe && (tool.sideEffect === "none" || tool.sideEffect === "read");
  }

  private async runRead(work: () => Promise<PtcToolRpcResponse>): Promise<PtcToolRpcResponse> {
    const priorWrite = this.writeTail;
    const completed = new Deferred();
    this.activeReads.add(completed.promise);
    try {
      await priorWrite;
      return await this.semaphore.use(work);
    } finally {
      completed.resolve();
      this.activeReads.delete(completed.promise);
    }
  }

  private async runBarrier(work: () => Promise<PtcToolRpcResponse>): Promise<PtcToolRpcResponse> {
    const priorWrite = this.writeTail;
    const priorReads = [...this.activeReads];
    const completed = new Deferred();
    this.writeTail = completed.promise;
    try {
      await priorWrite;
      await Promise.all(priorReads);
      return await this.semaphore.use(work);
    } finally {
      completed.resolve();
    }
  }

  private toRpcResponse(result: ToolResult): PtcToolRpcResponse {
    if (result.status === "error") return { ok: false, error: result.error };
    if (result.output.kind === "artifact") return { ok: true, output: { kind: "artifact", handle: result.output.handle } };
    try {
      const valueJson = JSON.stringify(result.output.value);
      if (valueJson === undefined) throw new Error("undefined");
      return { ok: true, output: { kind: "inline", valueJson } };
    } catch {
      return { ok: false, error: { code: "execution_failed", message: "Tool output could not be passed to PTC.", retryable: true } };
    }
  }
}

export interface PtcRuntimeOptions {
  registry: ToolRegistry;
  dispatcher: ToolDispatcher;
  artifactSpill?: ArtifactSpillService;
  sandbox?: PtcSandbox;
  policy?: Partial<PtcPolicy>;
  events?: EventBus<HarnessEventMap>;
  onInternalError?: (error: Error) => void;
}

export class PtcRuntime {
  readonly policy: PtcPolicy;
  readonly sdk: PtcSdkGenerator;
  private readonly sandbox: PtcSandbox;

  constructor(private readonly options: PtcRuntimeOptions) {
    this.policy = ptcPolicySchema.parse({ ...defaultPtcPolicy, ...options.policy });
    this.sdk = new PtcSdkGenerator(options.registry);
    this.sandbox = options.sandbox ?? new NodeProcessPtcSandbox();
  }

  sdkDescription(allowedToolNames?: readonly string[]): PtcSdkDescription {
    return this.sdk.describe(allowedToolNames);
  }

  async execute(rawInput: RunCodeInput, context: ToolExecutionContext): Promise<PtcExecutionResult> {
    const startedAt = Date.now();
    const executionId = randomUUID();
    const emptyStats = (): PtcExecutionStats => ({
      durationMs: Date.now() - startedAt,
      toolCalls: 0,
      peakConcurrency: 0,
      logBytes: 0,
      logsTruncated: false,
    });
    const input = runCodeInputSchema.safeParse(rawInput);
    if (!input.success) return { status: "error", error: ptcError("source_invalid", "run_code input is invalid.", false), artifacts: [], stats: emptyStats() };
    const effectivePolicy = {
      ...this.policy,
      maxExecutionMs: input.data.timeoutMs === undefined ? this.policy.maxExecutionMs : Math.min(this.policy.maxExecutionMs, input.data.timeoutMs),
    };
    let code: string;
    try {
      code = preparePtcCode(input.data.code, input.data.language);
    } catch (error) {
      const message = error instanceof PtcSourceError ? error.message : "PTC source could not be prepared.";
      const result: PtcExecutionResult = {
        status: "error", error: ptcError("source_invalid", message, false), artifacts: [], stats: emptyStats(),
      };
      await this.emitFailed(executionId, context, result);
      return result;
    }
    const dispatchContext: ToolDispatchContext = {
      sessionId: context.sessionId,
      agentId: context.agentId,
      principal: context.principal,
      // Copied only from host-issued execution context. The child protocol
      // never accepts identity or permission fields.
      grantedPermissions: context.grantedPermissions,
      allowedToolNames: context.allowedToolNames,
    };
    const scheduler = new PtcToolScheduler(this.options.registry, this.options.dispatcher, dispatchContext, effectivePolicy, executionId);
    const sdk = this.sdkDescription(context.allowedToolNames);
    await this.emit("ptc.started", { executionId, sessionId: context.sessionId, agentId: context.agentId });
    let sandboxResult: PtcSandboxExecutionResult;
    try {
      sandboxResult = await this.sandbox.execute({
        executionId,
        code,
        language: input.data.language,
        policy: effectivePolicy,
        sdk,
        signal: context.signal,
        onToolCall: (request) => scheduler.invoke(request),
      });
    } catch (error) {
      this.options.onInternalError?.(asError(error));
      sandboxResult = sandboxError("sandbox_crashed", "The PTC sandbox failed unexpectedly.", true);
    }
    const stats: PtcExecutionStats = {
      durationMs: Date.now() - startedAt,
      toolCalls: scheduler.toolCalls,
      peakConcurrency: scheduler.peakConcurrency,
      logBytes: sandboxResult.logBytes,
      logsTruncated: sandboxResult.logsTruncated,
    };
    if (sandboxResult.status === "error") {
      const result: PtcExecutionResult = {
        status: "error",
        error: sandboxResult.error ?? ptcError("execution_failed", "PTC execution failed.", true),
        artifacts: [],
        stats,
      };
      await this.emitFailed(executionId, context, result);
      return result;
    }
    if (sandboxResult.resultJson === undefined || sandboxResult.resultBytes === undefined) {
      const result: PtcExecutionResult = {
        status: "error", error: ptcError("serialization_failed", "PTC returned no JSON result.", false), artifacts: [], stats,
      };
      await this.emitFailed(executionId, context, result);
      return result;
    }
    try {
      const output = await this.finalizeResult(sandboxResult.resultJson, sandboxResult.resultBytes, context, executionId, stats);
      if (output.status === "error") {
        await this.emitFailed(executionId, context, output);
        return output;
      }
      await this.emit("ptc.completed", {
        executionId,
        sessionId: context.sessionId,
        agentId: context.agentId,
        durationMs: output.stats.durationMs,
        toolCallCount: output.stats.toolCalls,
        peakConcurrency: output.stats.peakConcurrency,
        status: "success",
      });
      return output;
    } catch (error) {
      this.options.onInternalError?.(asError(error));
      const result: PtcExecutionResult = {
        status: "error", error: ptcError("execution_failed", "PTC result processing failed.", true), artifacts: [], stats,
      };
      await this.emitFailed(executionId, context, result);
      return result;
    }
  }

  private async finalizeResult(
    resultJson: string,
    resultBytes: number,
    context: ToolExecutionContext,
    executionId: string,
    stats: PtcExecutionStats,
  ): Promise<PtcExecutionResult> {
    if (resultBytes <= this.policy.maxReturnedBytes) {
      return { status: "success", result: JSON.parse(resultJson) as unknown, artifacts: [], stats };
    }
    if (resultBytes > this.policy.maxSandboxResultBytes || !this.options.artifactSpill) {
      return {
        status: "error",
        error: ptcError("return_too_large", "PTC final result exceeds the configured return limit.", false),
        artifacts: [],
        stats,
      };
    }
    const spill = await this.options.artifactSpill.spill({
      sessionId: context.sessionId,
      type: "ptc-result",
      mimeType: "application/json",
      summary: "PTC result (" + String(resultBytes) + " bytes)",
      metadata: { executionId, agentId: context.agentId, toolCallCount: stats.toolCalls },
      content: resultJson,
    }, { forceArtifact: true });
    if (spill.kind !== "artifact") {
      return {
        status: "error",
        error: ptcError("return_too_large", "PTC final result could not be externalized.", false),
        artifacts: [],
        stats,
      };
    }
    return { status: "success", result: spill.handle, artifacts: [spill.handle], stats };
  }

  private async emitFailed(executionId: string, context: ToolExecutionContext, result: PtcExecutionResult): Promise<void> {
    if (result.status !== "error") return;
    await this.emit("ptc.failed", {
      executionId,
      sessionId: context.sessionId,
      agentId: context.agentId,
      durationMs: result.stats.durationMs,
      toolCallCount: result.stats.toolCalls,
      status: "error",
      errorCode: result.error.code,
    });
  }

  private async emit<K extends keyof HarnessEventMap>(event: K, payload: HarnessEventMap[K]): Promise<void> {
    try {
      await this.options.events?.emit(event, payload);
    } catch (error) {
      this.options.onInternalError?.(asError(error));
    }
  }
}

export function createRunCodeTool(runtime: PtcRuntime): ToolDefinition<RunCodeInput, PtcExecutionResult> {
  return defineTool({
    name: runCodeToolName,
    description: "Run a restricted TypeScript or JavaScript program that orchestrates registered Mnemos tools through the PTC runtime.",
    inputSchema: runCodeInputSchema,
    outputSchema: ptcExecutionResultSchema,
    requiredPermissions: ["tool:execute"],
    sideEffect: "none",
    concurrencySafe: false,
    // Dispatcher cancellation remains cooperative. Give the PTC child its own
    // wall-clock deadline plus generous spawn/cleanup room so the child can be
    // killed even when the host is under load or the child is reporting OOM.
    // Windows can take tens of seconds to reap a low-memory child, so the
    // outer dispatcher timeout must never race the sandbox's structured error.
    timeoutMs: runtime.policy.maxExecutionMs + 60_000,
    async execute(input, context) {
      return runtime.execute(input, context);
    },
  });
}

/** Registers the PTC entry point normally; callers still invoke it through ToolDispatcher. */
export function registerPtcTool(registry: ToolRegistry, runtime: PtcRuntime): void {
  registry.register(createRunCodeTool(runtime));
}

class PtcSourceError extends Error {}

function preparePtcCode(source: string, language: PtcLanguage): string {
  if (Buffer.byteLength(source) > 256 * 1024) throw new PtcSourceError("PTC source exceeds its size limit.");
  rejectAmbientCapabilities(source);
  try {
    if (language === "javascript") return source;
    // PTC source is an async function body and may legitimately use return.
    // Node's type-stripper parses a complete program, so give it a wrapper
    // before returning a transformed async body for the sandbox.
    return stripTypeScriptTypes(
      "async function __mnemosPtcProgram__() {\n" + source + "\n}",
      { mode: "transform", sourceUrl: "mnemos-ptc.ts" },
    ) + "\nreturn await __mnemosPtcProgram__();";
  } catch {
    throw new PtcSourceError("PTC source is not valid " + language + ".");
  }
}

/**
 * Defense in depth, not the primary process boundary. This rejects every
 * ambient-capability spelling deliberately unsupported in Phase 8. A future
 * container backend should retain it for early, predictable feedback.
 */
function rejectAmbientCapabilities(source: string): void {
  const forbidden: readonly RegExp[] = [
    /(^|[^\w$])import\s*(?:\(|[\w{*])/m,
    /(^|[^\w$])export\s/m,
    /\brequire\s*\(/,
    /\bprocess\s*(?:\.|\[)/,
    /\b(?:child_process|worker_threads|node:|fs|http|https|net|tls|dgram)\b/i,
    /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/,
    /\b(?:eval|Function|AsyncFunction|WebAssembly|Deno|Bun)\b/,
  ];
  if (forbidden.some((pattern) => pattern.test(source))) {
    throw new PtcSourceError("PTC source uses an ambient capability that is not available; use tools.* instead.");
  }
}

function ptcError(code: PtcErrorCode, message: string, retryable: boolean): PtcExecutionError {
  return { code, message, retryable };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/*
 * Trusted host bootstrap with no module imports. Generated code is compiled
 * only inside this short-lived process, receives lexical shadows for Node
 * globals, and can communicate solely through the Proxy SDK below.
 */
const PTC_CHILD_BOOTSTRAP = [
  '"use strict";',
  "const pending = new Map();",
  "let logBytes = 0;",
  "let logsTruncated = false;",
  "let maxLogBytes = 0;",
  "let maxToolArgumentBytes = 0;",
  "const encoder = new TextEncoder();",
  "function bytes(value) { return encoder.encode(value).byteLength; }",
  "function text(value) {",
  "  try { const serialized = JSON.stringify(value); return serialized === undefined ? String(value) : serialized; }",
  "  catch { return '[unserializable log value]'; }",
  "}",
  "function recordLog(values) {",
  "  const rendered = values.map(text).join(' ');",
  "  const next = bytes(rendered);",
  "  if (logBytes + next > maxLogBytes) { logsTruncated = true; logBytes = maxLogBytes; return; }",
  "  logBytes += next;",
  "}",
  "function safeConsole() {",
  "  return Object.freeze({ log: (...values) => recordLog(values), info: (...values) => recordLog(values), warn: (...values) => recordLog(values), error: (...values) => recordLog(values) });",
  "}",
  "class ToolError extends Error {",
  "  constructor(code, message, retryable) { super(message); this.name = 'ToolError'; this.code = code; this.retryable = retryable; }",
  "}",
  "function rpc(toolName, input) {",
  "  let argumentsJson;",
  "  try { argumentsJson = JSON.stringify(input); if (argumentsJson === undefined || bytes(argumentsJson) > maxToolArgumentBytes) throw new Error('invalid'); }",
  "  catch { return Promise.reject(new ToolError('invalid_arguments', 'Tool arguments must be JSON-serializable.', false)); }",
  "  const requestId = String(Date.now()) + ':' + String(Math.random()) + ':' + String(pending.size);",
  "  return new Promise((resolve, reject) => {",
  "    pending.set(requestId, { resolve, reject });",
  "    process.send({ type: 'tool-call', requestId, toolName, argumentsJson });",
  "  });",
  "}",
  "function makeTools(path) {",
  "  const target = function() {};",
  "  return new Proxy(target, {",
  "    get(_target, property) { if (property === 'then') return undefined; if (typeof property !== 'string') return undefined; return makeTools(path.concat(property)); },",
  "    apply(_target, _thisArg, values) {",
  "      if (path.length === 0 || values.length !== 1) return Promise.reject(new ToolError('invalid_arguments', 'A tool expects exactly one input object.', false));",
  "      return rpc(path.join('.'), values[0]);",
  "    },",
  "  });",
  "}",
  "function sendFailure(code, message, retryable) { process.send({ type: 'failed', error: { code, message, retryable }, logBytes, logsTruncated }); }",
  "process.on('message', async (message) => {",
  "  if (!message || typeof message.type !== 'string') return;",
  "  if (message.type === 'tool-result') {",
  "    const request = pending.get(message.requestId); if (!request) return; pending.delete(message.requestId);",
  "    if (!message.ok) { request.reject(new ToolError(message.error.code, message.error.message, message.error.retryable)); return; }",
  "    try { request.resolve(message.output.kind === 'inline' ? JSON.parse(message.output.valueJson) : message.output.handle); }",
  "    catch { request.reject(new ToolError('execution_failed', 'Tool runtime returned invalid JSON.', true)); }",
  "    return;",
  "  }",
  "  if (message.type !== 'execute') return;",
  "  maxLogBytes = message.maxLogBytes;",
  "  maxToolArgumentBytes = message.maxToolArgumentBytes;",
  "  try {",
  "    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;",
  "    const program = new AsyncFunction('tools', 'console', 'ToolError', 'process', 'require', 'module', 'global', 'globalThis', 'fetch', 'Function', 'Buffer', '\"use strict\";\\n' + message.code);",
  "    const result = await program(makeTools([]), safeConsole(), ToolError, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined);",
  "    let resultJson;",
  "    try { resultJson = JSON.stringify(result); } catch { sendFailure('serialization_failed', 'PTC result must be JSON-serializable.', false); return; }",
  "    if (resultJson === undefined) { sendFailure('serialization_failed', 'PTC result must be JSON-serializable.', false); return; }",
  "    const resultBytes = bytes(resultJson);",
  "    if (resultBytes > message.maxSandboxResultBytes) { sendFailure('return_too_large', 'PTC final result exceeds the sandbox transport limit.', false); return; }",
  "    process.send({ type: 'completed', resultJson, resultBytes, logBytes, logsTruncated });",
  "  } catch (error) {",
  "    const messageText = error && typeof error.message === 'string' ? error.message.slice(0, 512) : 'PTC program failed.';",
  "    const code = error && error.code === 'tool_call_quota_exceeded' ? 'tool_call_quota_exceeded' : 'execution_failed';",
  "    sendFailure(code, messageText, code === 'execution_failed');",
  "  }",
  "});",
].join("\n");
