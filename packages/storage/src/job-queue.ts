import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { DurableJobQueue, DurableJobRecord, DurableJobStatus } from "@mnemos/core";

interface StoredJob { id: string; type: string; payload: string; status: DurableJobStatus; available_at: string; lease_until: string | null; worker_id: string | null; attempts: number; max_attempts: number; created_at: string; updated_at: string; last_error: string | null; }

function open(filename: string): Database.Database {
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS durable_jobs (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
    available_at TEXT NOT NULL, lease_until TEXT, worker_id TEXT,
    attempts INTEGER NOT NULL CHECK (attempts >= 0), max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_error TEXT
  ); CREATE INDEX IF NOT EXISTS idx_durable_jobs_claim ON durable_jobs(status, available_at, lease_until, created_at, id);`);
  return db;
}

export class SqliteDurableJobQueue<TPayload = unknown> implements DurableJobQueue<TPayload> {
  private readonly db: Database.Database;
  constructor(filename: string) { this.db = open(filename); }
  async enqueue(type: string, payload: TPayload, options: { id?: string; availableAt?: string; maxAttempts?: number } = {}): Promise<DurableJobRecord<TPayload>> {
    const now = new Date().toISOString();
    const id = options.id ?? randomUUID();
    this.db.prepare(`INSERT INTO durable_jobs (id,type,payload,status,available_at,lease_until,worker_id,attempts,max_attempts,created_at,updated_at,last_error) VALUES (?,?,?,'pending',?,NULL,NULL,0,?,?,?,NULL)`).run(id, type, JSON.stringify(payload), options.availableAt ?? now, options.maxAttempts ?? 8, now, now);
    return this.require(id);
  }
  async claim(workerId: string, now = new Date(), leaseMs = 30_000): Promise<DurableJobRecord<TPayload> | undefined> {
    const nowIso = now.toISOString();
    const lease = new Date(now.getTime() + leaseMs).toISOString();
    return this.db.transaction(() => {
      this.db.prepare("UPDATE durable_jobs SET status='pending', lease_until=NULL, worker_id=NULL, updated_at=? WHERE status='running' AND lease_until IS NOT NULL AND lease_until <= ?").run(nowIso, nowIso);
      const row = this.db.prepare("SELECT * FROM durable_jobs WHERE status='pending' AND available_at <= ? ORDER BY created_at ASC, id ASC LIMIT 1").get(nowIso) as StoredJob | undefined;
      if (!row) return undefined;
      const updated = this.db.prepare("UPDATE durable_jobs SET status='running', lease_until=?, worker_id=?, attempts=attempts+1, updated_at=? WHERE id=? AND status='pending'").run(lease, workerId, nowIso, row.id);
      return updated.changes === 1 ? this.require(row.id) : undefined;
    })();
  }
  async heartbeat(id: string, workerId: string, leaseMs = 30_000): Promise<DurableJobRecord<TPayload>> { return this.transition(id, workerId, "running", new Date(Date.now() + leaseMs).toISOString()); }
  async complete(id: string, workerId: string): Promise<DurableJobRecord<TPayload>> { return this.transition(id, workerId, "completed", undefined); }
  async fail(id: string, workerId: string, error: string, retryAt = new Date()): Promise<DurableJobRecord<TPayload>> {
    const current = this.require(id);
    const status: DurableJobStatus = current.attempts < current.maxAttempts ? "pending" : "failed";
    const availableAt = status === "pending" ? retryAt.toISOString() : current.availableAt;
    const result = this.db.prepare("UPDATE durable_jobs SET status=?, available_at=?, lease_until=NULL, worker_id=NULL, last_error=?, updated_at=? WHERE id=? AND status='running' AND worker_id=?").run(status, availableAt, error.slice(0, 4_096), new Date().toISOString(), id, workerId);
    if (result.changes !== 1) throw new Error(`Job ${id} is not owned by worker ${workerId}`);
    return this.require(id);
  }
  async recoverExpired(now = new Date()): Promise<number> { return Number(this.db.prepare("UPDATE durable_jobs SET status='pending', lease_until=NULL, worker_id=NULL, updated_at=?, last_error=COALESCE(last_error,'lease expired') WHERE status='running' AND lease_until IS NOT NULL AND lease_until <= ?").run(now.toISOString(), now.toISOString()).changes); }
  async get(id: string): Promise<DurableJobRecord<TPayload> | undefined> { const row = this.db.prepare("SELECT * FROM durable_jobs WHERE id=?").get(id) as StoredJob | undefined; return row ? this.toRecord(row) : undefined; }
  async list(status?: DurableJobStatus): Promise<readonly DurableJobRecord<TPayload>[]> { const rows = (status ? this.db.prepare("SELECT * FROM durable_jobs WHERE status=? ORDER BY created_at,id").all(status) : this.db.prepare("SELECT * FROM durable_jobs ORDER BY created_at,id").all()) as StoredJob[]; return rows.map((row) => this.toRecord(row)); }
  depth(): number { return Number((this.db.prepare("SELECT COUNT(*) AS count FROM durable_jobs WHERE status IN ('pending','running')").get() as { count: number }).count); }
  close(): void { this.db.close(); }
  private transition(id: string, workerId: string, status: DurableJobStatus, leaseUntil: string | undefined): DurableJobRecord<TPayload> {
    const result = this.db.prepare("UPDATE durable_jobs SET status=?, lease_until=?, worker_id=?, updated_at=? WHERE id=? AND status='running' AND worker_id=?").run(status, leaseUntil ?? null, status === "running" ? workerId : null, new Date().toISOString(), id, workerId);
    if (result.changes !== 1) throw new Error(`Job ${id} is not owned by worker ${workerId}`);
    return this.require(id);
  }
  private require(id: string): DurableJobRecord<TPayload> { const row = this.db.prepare("SELECT * FROM durable_jobs WHERE id=?").get(id) as StoredJob | undefined; if (!row) throw new Error(`Job not found: ${id}`); return this.toRecord(row); }
  private toRecord(row: StoredJob): DurableJobRecord<TPayload> { return { id: row.id, type: row.type, payload: JSON.parse(row.payload) as TPayload, status: row.status, availableAt: row.available_at, ...(row.lease_until === null ? {} : { leaseUntil: row.lease_until }), ...(row.worker_id === null ? {} : { workerId: row.worker_id }), attempts: row.attempts, maxAttempts: row.max_attempts, createdAt: row.created_at, updatedAt: row.updated_at, ...(row.last_error === null ? {} : { lastError: row.last_error }) }; }
}
