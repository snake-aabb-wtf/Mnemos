import Database from "better-sqlite3";
import type {
  MemoryIntelligenceAuditEntry,
  MemoryIntelligenceAuditStore,
} from "@mnemos/core";

interface StoredAuditEntry {
  id: string;
  operation: MemoryIntelligenceAuditEntry["operation"];
  memory_ids: string;
  source_ids: string;
  reason: string | null;
  policy_version: string;
  created_at: string;
}

/** Durable, replaceable audit projection for Phase 11 derived-state mutations. */
export class SqliteMemoryIntelligenceAuditStore implements MemoryIntelligenceAuditStore {
  private readonly db: Database.Database;

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_intelligence_audit (
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        memory_ids TEXT NOT NULL,
        source_ids TEXT NOT NULL,
        reason TEXT,
        policy_version TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_intelligence_audit_created
        ON memory_intelligence_audit(created_at, id);
    `);
  }

  async append(entry: MemoryIntelligenceAuditEntry): Promise<void> {
    this.db.prepare(`
      INSERT OR IGNORE INTO memory_intelligence_audit
        (id, operation, memory_ids, source_ids, reason, policy_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.operation,
      JSON.stringify(entry.memoryIds),
      JSON.stringify(entry.sourceIds),
      entry.reason ?? null,
      entry.policyVersion,
      entry.createdAt,
    );
  }

  async list(): Promise<readonly MemoryIntelligenceAuditEntry[]> {
    const rows = this.db.prepare("SELECT * FROM memory_intelligence_audit ORDER BY created_at ASC, id ASC").all() as StoredAuditEntry[];
    return rows.map((row) => ({
      id: row.id,
      operation: row.operation,
      memoryIds: parseArray(row.memory_ids),
      sourceIds: parseArray(row.source_ids),
      ...(row.reason === null ? {} : { reason: row.reason }),
      policyVersion: row.policy_version,
      createdAt: row.created_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}

function parseArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item): item is string => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}
