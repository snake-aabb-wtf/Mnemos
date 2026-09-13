import type { BuiltContext } from "./context.js";

/** Provider-neutral native tool declaration derived from a registered Zod schema. */
export interface ModelToolDeclaration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ModelRequest {
  sessionId: string;
  input: string;
  context: BuiltContext;
  /** Omitted for callers that do not enable the Phase 7 Tool Runtime. */
  tools?: readonly ModelToolDeclaration[];
}

export interface TextModelResponse {
  /** Kept optional for compatibility with existing providers that return { content }. */
  kind?: "text";
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ToolCallModelResponse {
  kind: "tool-calls";
  toolCalls: readonly ModelToolCall[];
  metadata?: Record<string, unknown>;
}

export type ModelResponse = TextModelResponse | ToolCallModelResponse;

export interface ModelProvider {
  generate(request: ModelRequest): Promise<ModelResponse>;
}

export class MockModelProvider implements ModelProvider {
  constructor(private readonly responder: (request: ModelRequest) => ModelResponse | Promise<ModelResponse> = () => ({ content: "Mock response" })) {}

  generate(request: ModelRequest): Promise<ModelResponse> {
    return Promise.resolve(this.responder(request));
  }
}

export class VisibleAgent {
  constructor(private readonly provider: ModelProvider) {}

  respond(request: ModelRequest): Promise<ModelResponse> {
    return this.provider.generate(request);
  }
}
