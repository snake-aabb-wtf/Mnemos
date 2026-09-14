import Database from "better-sqlite3";
import type { ToolAuditEntry, ToolAuditStore } from "@mnemos/core";

interface StoredAudit { call_id: string; tool_name: string; session_id: string; agent_id: string; principal: string; started_at: string; duration_ms: number; status: ToolAuditEntry["status"]; error_code: string | null; output_kind: string | null; spilled: number | null; }

/** SQLite-backed compact audit projection; raw arguments and outputs are never persisted. */
export class SqliteToolAuditStore implements ToolAuditStore {
  private readonly db: Database.Database;
  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS tool_audit (
      call_id TEXT PRIMARY KEY, tool_name TEXT NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      principal TEXT NOT NULL, started_at TEXT NOT NULL, duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('success','error','denied')), error_code TEXT,
      output_kind TEXT, spilled INTEGER
    ); CREATE INDEX IF NOT EXISTS idx_tool_audit_session_started ON tool_audit(session_id, started_at);`);
  }
  async append(entry: ToolAuditEntry): Promise<void> {
    this.db.prepare("INSERT OR REPLACE INTO tool_audit (call_id,tool_name,session_id,agent_id,principal,started_at,duration_ms,status,error_code,output_kind,spilled) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(entry.callId, entry.toolName, entry.sessionId, entry.agentId, entry.principal, entry.startedAt, entry.durationMs, entry.status, entry.errorCode ?? null, entry.outputKind ?? null, entry.spilled === undefined ? null : entry.spilled ? 1 : 0);
  }
  async list(filter: { sessionId?: string; callId?: string; limit?: number } = {}): Promise<readonly ToolAuditEntry[]> {
    const limit = filter.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 0) throw new Error("Audit limit must be a non-negative integer");
    const rows = this.db.prepare(`SELECT * FROM tool_audit WHERE (? IS NULL OR session_id = ?) AND (? IS NULL OR call_id = ?) ORDER BY started_at DESC, rowid DESC LIMIT ?`).all(filter.sessionId ?? null, filter.sessionId ?? null, filter.callId ?? null, filter.callId ?? null, limit) as StoredAudit[];
    return rows.reverse().map((row) => ({ callId: row.call_id, toolName: row.tool_name, sessionId: row.session_id, agentId: row.agent_id, principal: row.principal, startedAt: row.started_at, durationMs: row.duration_ms, status: row.status, ...(row.error_code === null ? {} : { errorCode: row.error_code as ToolAuditEntry["errorCode"] }), ...(row.output_kind === null ? {} : { outputKind: row.output_kind as ToolAuditEntry["outputKind"] }), ...(row.spilled === null ? {} : { spilled: row.spilled === 1 }) }));
  }
  async cleanup(options: { before?: Date; maxRows?: number } = {}): Promise<number> {
    let removed = 0;
    if (options.before) removed += this.db.prepare("DELETE FROM tool_audit WHERE started_at < ?").run(options.before.toISOString()).changes;
    if (options.maxRows !== undefined) {
      if (!Number.isInteger(options.maxRows) || options.maxRows < 0) throw new Error("maxRows must be non-negative");
      removed += this.db.prepare("DELETE FROM tool_audit WHERE rowid IN (SELECT rowid FROM tool_audit ORDER BY started_at DESC, rowid DESC LIMIT -1 OFFSET ?)").run(options.maxRows).changes;
    }
    return removed;
  }
  count(): number { return Number((this.db.prepare("SELECT COUNT(*) AS count FROM tool_audit").get() as { count: number }).count); }
  close(): void { this.db.close(); }
}
