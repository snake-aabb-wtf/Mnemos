import { spawnSync } from "node:child_process";
import type { PtcExecutionRequest, PtcSandbox, PtcSandboxExecutionResult } from "./ptc.js";
import type { RuntimeConfig } from "./production.js";

export interface SandboxCapabilities {
  backend: "development-subprocess" | "production-container";
  network: "denied" | "unknown";
  filesystem: "scratch-only" | "unknown";
  processIsolation: "process" | "container";
  hardTimeout: boolean;
  memoryLimit: boolean;
}

export interface PtcSandboxBackend extends PtcSandbox {
  readonly capabilities: SandboxCapabilities;
  isAvailable(): Promise<boolean>;
}

/** Explicit adapter for the Phase 8 subprocess backend. It is not hostile-code isolation. */
export class DevelopmentSandboxBackend implements PtcSandboxBackend {
  readonly capabilities: SandboxCapabilities = { backend: "development-subprocess", network: "denied", filesystem: "scratch-only", processIsolation: "process", hardTimeout: true, memoryLimit: true };
  constructor(private readonly delegate: PtcSandbox) {}
  async isAvailable(): Promise<boolean> { return true; }
  execute(request: PtcExecutionRequest): Promise<PtcSandboxExecutionResult> { return this.delegate.execute(request); }
}

/**
 * Capability-gated container boundary. The adapter deliberately fails closed
 * when Docker is unavailable; it never silently downgrades a production
 * request to the development subprocess backend.
 */
export class ContainerSandboxBackend implements PtcSandboxBackend {
  readonly capabilities: SandboxCapabilities = { backend: "production-container", network: "denied", filesystem: "scratch-only", processIsolation: "container", hardTimeout: true, memoryLimit: true };
  constructor(private readonly dockerExecutable = "docker") {}
  async isAvailable(): Promise<boolean> {
    const result = spawnSync(this.dockerExecutable, ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore", windowsHide: true });
    return result.status === 0;
  }
  async execute(_request: PtcExecutionRequest): Promise<PtcSandboxExecutionResult> {
    if (!(await this.isAvailable())) return {
      status: "error", error: { code: "sandbox_crashed", message: "Production container sandbox is unavailable.", retryable: false }, logBytes: 0, logsTruncated: false,
    };
    // The Docker RPC runner is intentionally a separate deployment adapter.
    // Failing closed here is safer than pretending a host subprocess is a
    // container when the adapter has not been configured with an image.
    return {
      status: "error", error: { code: "sandbox_crashed", message: "Production container sandbox requires an explicitly configured runner image.", retryable: false }, logBytes: 0, logsTruncated: false,
    };
  }
}

export async function detectSandboxBackends(): Promise<readonly SandboxCapabilities[]> {
  const container = new ContainerSandboxBackend();
  const development = new DevelopmentSandboxBackend({ execute: async () => ({ status: "error", logBytes: 0, logsTruncated: false }) });
  return [development.capabilities, ...(await container.isAvailable() ? [container.capabilities] : [])];
}

export function selectSandboxBackend(config: RuntimeConfig, development: PtcSandbox): PtcSandboxBackend {
  if (config.ptc.backend === "production-container") {
    if (!config.security.allowProductionSandbox) throw new Error("Production sandbox backend is disabled by security policy");
    return new ContainerSandboxBackend();
  }
  return new DevelopmentSandboxBackend(development);
}
