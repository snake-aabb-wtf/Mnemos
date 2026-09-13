import Database from "better-sqlite3";
import {
  consolidationJobSchema,
  newConsolidationJob,
  type ConsolidationJob,
  type ConsolidationJobStatus,
  type ConsolidationJobStore,
  type ContextEviction,
  type EnqueueConsolidationJobResult,
  type MemoryRememberRequest,
  newVisibleCandidateConsolidationJob,
} from "@mnemos/core";

interface StoredJob {
  id: string;
  deduplication_key: string;
  origin: "eviction" | "visible-candidate";
  session_id: string;
  source_range: string;
  evicted_message_ids: string;
  candidate_hints: string;
  status: ConsolidationJobStatus;
  attempts: number;
  created_at: string;
  updated_at: string;
  last_error: string | null;
}

function openJobDatabase(filename: string): Database.Database {
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function migrateJobs(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_consolidation_jobs (
      id TEXT PRIMARY KEY,
      deduplication_key TEXT NOT NULL UNIQUE,
      origin TEXT NOT NULL DEFAULT 'eviction' CHECK (origin IN ('eviction', 'visible-candidate')),
      session_id TEXT NOT NULL,
      source_range TEXT NOT NULL,
      evicted_message_ids TEXT NOT NULL,
      candidate_hints TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
      attempts INTEGER NOT NULL CHECK (attempts >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_consolidation_jobs_next
      ON memory_consolidation_jobs (status, created_at, id);
  `);
  const columns = db.prepare("PRAGMA table_info(memory_consolidation_jobs)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "origin")) {
    db.exec("ALTER TABLE memory_consolidation_jobs ADD COLUMN origin TEXT NOT NULL DEFAULT 'eviction'");
  }
  if (!columns.some((column) => column.name === "candidate_hints")) {
    db.exec("ALTER TABLE memory_consolidation_jobs ADD COLUMN candidate_hints TEXT NOT NULL DEFAULT '[]'");
  }
}

/**
 * SQLite durable queue for Phase 4. The unique deduplication key turns repeated
 * context.evicted delivery into a read of the original job rather than new work.
 */
export class SqliteConsolidationJobStore implements ConsolidationJobStore {
  private readonly db: Database.Database;

  constructor(filename: string) {
    this.db = openJobDatabase(filename);
    migrateJobs(this.db);
  }

  async enqueue(eviction: ContextEviction): Promise<EnqueueConsolidationJobResult> {
    const job = newConsolidationJob(eviction);
    return this.db.transaction(() => {
      const inserted = this.db.prepare(`
        INSERT INTO memory_consolidation_jobs (
          id, deduplication_key, origin, session_id, source_range, evicted_message_ids, candidate_hints,
          status, attempts, created_at, updated_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(deduplication_key) DO NOTHING
      `).run(
        job.id,
        job.deduplicationKey,
        job.origin,
        job.sessionId,
        JSON.stringify(job.sourceRange),
        JSON.stringify(job.evictedMessageIds),
        JSON.stringify(job.candidateHints),
        job.status,
        job.attempts,
        job.createdAt,
        job.updatedAt,
      );
      const stored = inserted.changes === 1
        ? this.require(job.id)
        : this.requireByKey(job.deduplicationKey);
      return { job: stored, created: inserted.changes === 1 };
    })();
  }

  async enqueueVisibleCandidate(request: MemoryRememberRequest): Promise<EnqueueConsolidationJobResult> {
    const job = newVisibleCandidateConsolidationJob(request);
    return this.insertOrGet(job);
  }

  async get(id: string): Promise<ConsolidationJob | undefined> {
    const row = this.db.prepare("SELECT * FROM memory_consolidation_jobs WHERE id = ?").get(id) as StoredJob | undefined;
    return row === undefined ? undefined : this.toJob(row);
  }

  async claimNext(): Promise<ConsolidationJob | undefined> {
    return this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM memory_consolidation_jobs
        WHERE status = 'pending'
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `).get() as StoredJob | undefined;
      if (!row) return undefined;
      const updatedAt = new Date().toISOString();
      const result = this.db.prepare(`
        UPDATE memory_consolidation_jobs
        SET status = 'running', attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(updatedAt, row.id);
      if (result.changes !== 1) return undefined;
      return this.require(row.id);
    })();
  }

  async complete(id: string): Promise<ConsolidationJob> {
    return this.transition(id, "completed", undefined, ["running"]);
  }

  async fail(id: string, error: string): Promise<ConsolidationJob> {
    return this.transition(id, "failed", error, ["running"]);
  }

  async retry(id: string): Promise<ConsolidationJob> {
    return this.transition(id, "pending", undefined, ["failed"]);
  }

  async recoverRunning(): Promise<number> {
    return this.db.prepare(`
      UPDATE memory_consolidation_jobs
      SET status = 'pending', updated_at = ?,
          last_error = COALESCE(last_error, 'Worker interrupted before completion')
      WHERE status = 'running'
    `).run(new Date().toISOString()).changes;
  }

  async list(statuses?: readonly ConsolidationJobStatus[]): Promise<ConsolidationJob[]> {
    if (statuses !== undefined && statuses.length === 0) return [];
    const rows = statuses === undefined
      ? this.db.prepare("SELECT * FROM memory_consolidation_jobs ORDER BY created_at ASC, id ASC").all()
      : this.db.prepare(`
        SELECT * FROM memory_consolidation_jobs
        WHERE status IN (${statuses.map(() => "?").join(", ")})
        ORDER BY created_at ASC, id ASC
      `).all(...statuses);
    return (rows as StoredJob[]).map((row) => this.toJob(row));
  }

  close(): void {
    this.db.close();
  }

  private transition(id: string, status: ConsolidationJobStatus, error: string | undefined, allowed: readonly ConsolidationJobStatus[]): ConsolidationJob {
    const result = this.db.prepare(`
      UPDATE memory_consolidation_jobs
      SET status = ?, updated_at = ?, last_error = ?
      WHERE id = ? AND status IN (${allowed.map(() => "?").join(", ")})
    `).run(status, new Date().toISOString(), error ?? null, id, ...allowed);
    if (result.changes !== 1) throw new Error(`Cannot transition consolidation job ${id} to ${status}`);
    return this.require(id);
  }

  private require(id: string): ConsolidationJob {
    const row = this.db.prepare("SELECT * FROM memory_consolidation_jobs WHERE id = ?").get(id) as StoredJob | undefined;
    if (!row) throw new Error(`Consolidation job not found: ${id}`);
    return this.toJob(row);
  }

  private requireByKey(key: string): ConsolidationJob {
    const row = this.db.prepare("SELECT * FROM memory_consolidation_jobs WHERE deduplication_key = ?").get(key) as StoredJob | undefined;
    if (!row) throw new Error(`Consolidation job not found for key: ${key}`);
    return this.toJob(row);
  }

  private toJob(row: StoredJob): ConsolidationJob {
    return consolidationJobSchema.parse({
      id: row.id,
      deduplicationKey: row.deduplication_key,
      origin: row.origin,
      sessionId: row.session_id,
      sourceRange: JSON.parse(row.source_range) as unknown,
      evictedMessageIds: JSON.parse(row.evicted_message_ids) as unknown,
      candidateHints: JSON.parse(row.candidate_hints) as unknown,
      status: row.status,
      attempts: row.attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.last_error === null ? {} : { lastError: row.last_error }),
    });
  }

  private insertOrGet(job: ConsolidationJob): EnqueueConsolidationJobResult {
    return this.db.transaction(() => {
      const inserted = this.db.prepare(`
        INSERT INTO memory_consolidation_jobs (
          id, deduplication_key, origin, session_id, source_range, evicted_message_ids, candidate_hints,
          status, attempts, created_at, updated_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(deduplication_key) DO NOTHING
      `).run(
        job.id,
        job.deduplicationKey,
        job.origin,
        job.sessionId,
        JSON.stringify(job.sourceRange),
        JSON.stringify(job.evictedMessageIds),
        JSON.stringify(job.candidateHints),
        job.status,
        job.attempts,
        job.createdAt,
        job.updatedAt,
      );
      const stored = inserted.changes === 1 ? this.require(job.id) : this.requireByKey(job.deduplicationKey);
      return { job: stored, created: inserted.changes === 1 };
    })();
  }
}
