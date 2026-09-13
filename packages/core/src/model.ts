import type { BuiltContext } from "./context.js";

export interface ModelRequest {
  sessionId: string;
  input: string;
  context: BuiltContext;
}

export interface ModelResponse {
  content: string;
  metadata?: Record<string, unknown>;
}

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
