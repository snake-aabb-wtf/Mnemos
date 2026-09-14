import type { EventBus, HarnessEventMap } from "./events.js";

export interface RuntimeLifecycleOptions {
  runtimeVersion: string;
  profile: string;
  shutdownGracePeriodMs: number;
  events?: EventBus<HarnessEventMap>;
  stopWorkers?: (gracePeriodMs: number) => Promise<void>;
  flushAudit?: () => Promise<void>;
  terminateSandboxes?: () => Promise<void>;
  closeStores?: () => Promise<void>;
}

/** Coordinates shutdown ordering without owning any particular storage backend. */
export class RuntimeLifecycle {
  private startedAt = 0;
  private stopping?: Promise<void>;
  constructor(private readonly options: RuntimeLifecycleOptions) {}
  async start(schemaVersion?: number): Promise<void> {
    this.startedAt = Date.now();
    await this.options.events?.emit("runtime.started", { runtimeVersion: this.options.runtimeVersion, profile: this.options.profile, processId: process.pid });
    await this.options.events?.emit("runtime.ready", { runtimeVersion: this.options.runtimeVersion, ...(schemaVersion === undefined ? {} : { schemaVersion }) });
  }
  async shutdown(reason = "requested"): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      await this.options.events?.emit("runtime.shutting_down", { reason, gracePeriodMs: this.options.shutdownGracePeriodMs });
      await this.options.stopWorkers?.(this.options.shutdownGracePeriodMs);
      await this.options.flushAudit?.();
      await this.options.terminateSandboxes?.();
      await this.options.closeStores?.();
      await this.options.events?.emit("runtime.stopped", { durationMs: Date.now() - this.startedAt });
    })();
    return this.stopping;
  }
}

/** Serializes mutable operations per session while allowing independent sessions to progress. */
export class SessionMutex {
  private readonly queues = new Map<string, Promise<void>>();
  async run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(sessionId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = prior.then(() => gate);
    this.queues.set(sessionId, queued);
    await prior;
    try { return await operation(); }
    finally { release(); if (this.queues.get(sessionId) === queued) this.queues.delete(sessionId); }
  }
}
