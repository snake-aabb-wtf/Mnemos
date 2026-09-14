export type DurableJobStatus = "pending" | "running" | "completed" | "failed";

export interface DurableJobRecord<TPayload = unknown> {
  id: string;
  type: string;
  payload: TPayload;
  status: DurableJobStatus;
  availableAt: string;
  leaseUntil?: string;
  workerId?: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface DurableJobQueue<TPayload = unknown> {
  enqueue(type: string, payload: TPayload, options?: { id?: string; availableAt?: string; maxAttempts?: number }): Promise<DurableJobRecord<TPayload>>;
  claim(workerId: string, now?: Date, leaseMs?: number): Promise<DurableJobRecord<TPayload> | undefined>;
  heartbeat(id: string, workerId: string, leaseMs?: number): Promise<DurableJobRecord<TPayload>>;
  complete(id: string, workerId: string): Promise<DurableJobRecord<TPayload>>;
  fail(id: string, workerId: string, error: string, retryAt?: Date): Promise<DurableJobRecord<TPayload>>;
  recoverExpired(now?: Date): Promise<number>;
  get(id: string): Promise<DurableJobRecord<TPayload> | undefined>;
  list(status?: DurableJobStatus): Promise<readonly DurableJobRecord<TPayload>[]>;
  depth?(): number;
  close(): void;
}

export interface DurableWorkerOptions {
  workerId: string;
  concurrency: number;
  pollIntervalMs: number;
  leaseMs: number;
  maxAttempts: number;
  onError?: (error: Error, job: DurableJobRecord) => void;
  metrics?: import("./observability.js").MetricsSink;
}

/** Single-process worker loop; queue claim semantics make multiple instances safe. */
export class DurableWorker<TPayload = unknown> {
  private running = false;
  private readonly active = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly queue: DurableJobQueue<TPayload>, private readonly handler: (job: DurableJobRecord<TPayload>) => Promise<void>, private readonly options: DurableWorkerOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error("Worker concurrency must be positive");
  }
  get activeCount(): number { return this.active.size; }
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.tick();
  }
  async stop(gracePeriodMs = 10_000): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    const deadline = Date.now() + gracePeriodMs;
    while (this.active.size > 0 && Date.now() < deadline) await Promise.race(this.active);
  }
  async tick(): Promise<void> {
    if (!this.running) return;
    while (this.active.size < this.options.concurrency) {
      const job = await this.queue.claim(this.options.workerId, new Date(), this.options.leaseMs);
      if (!job) break;
      const execution = this.execute(job);
      this.active.add(execution);
      this.options.metrics?.gauge("job.worker.active", this.active.size, { worker: this.options.workerId });
      void execution.finally(() => {
        this.active.delete(execution);
        this.options.metrics?.gauge("job.worker.active", this.active.size, { worker: this.options.workerId });
      });
    }
    if (this.running) this.timer = setTimeout(() => { void this.tick(); }, this.options.pollIntervalMs);
  }
  private async execute(job: DurableJobRecord<TPayload>): Promise<void> {
    try {
      await this.handler(job);
      await this.queue.complete(job.id, this.options.workerId);
      this.options.metrics?.increment("job.completed", 1, { type: job.type });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Job failed.";
      try { await this.queue.fail(job.id, this.options.workerId, message); } catch { /* lease recovery remains authoritative */ }
      this.options.metrics?.increment("job.failed", 1, { type: job.type });
      this.options.onError?.(error instanceof Error ? error : new Error(message), job);
    }
  }
}
