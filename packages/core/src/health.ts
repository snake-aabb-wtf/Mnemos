export interface HealthCheck { name: string; check(): Promise<{ ok: boolean; detail?: string }>; }
export interface HealthReport { status: "ok" | "not_ready"; checks: readonly { name: string; ok: boolean; detail?: string }[]; generatedAt: string; }

/** Liveness is intentionally cheap; readiness runs configured dependency checks. */
export class RuntimeHealthService {
  constructor(private readonly checks: readonly HealthCheck[] = [], private readonly version = "0.1.0") {}
  liveness(): { status: "ok"; version: string; uptimeSeconds: number } { return { status: "ok", version: this.version, uptimeSeconds: Math.floor(process.uptime()) }; }
  async readiness(): Promise<HealthReport> {
    const results = [];
    for (const check of this.checks) {
      try { results.push({ name: check.name, ...(await check.check()) }); }
      catch (error) { results.push({ name: check.name, ok: false, detail: error instanceof Error ? error.message : "health check failed" }); }
    }
    return { status: results.every((result) => result.ok) ? "ok" : "not_ready", checks: results, generatedAt: new Date().toISOString() };
  }
}
