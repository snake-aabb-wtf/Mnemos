import Database from "better-sqlite3";
import {
  embeddingModelDescriptorSchema,
  memoryVectorRecordSchema,
  type MemoryVectorFilters,
  type MemoryVectorRecord,
  type MemoryVectorSearchHit,
  type MemoryVectorSearchQuery,
  type MemoryVectorStore,
} from "@mnemos/core";

interface StoredVector {
  memory_id: string;
  values_json: string;
  dimensions: number;
  model: string;
  model_version: string;
  content_hash: string;
  type: MemoryVectorRecord["type"];
  status: MemoryVectorRecord["status"];
  source_type: MemoryVectorRecord["sourceType"];
  confidence: number;
  created_at: string;
  updated_at: string;
  entities_json: string;
  tags_json: string;
  session_ids_json: string;
  indexed_at: string;
}

function openVectorDatabase(filename: string): Database.Database {
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function migrateVectors(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_vectors (
      memory_id TEXT PRIMARY KEY,
      values_json TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK (dimensions > 0),
      model TEXT NOT NULL,
      model_version TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      source_type TEXT NOT NULL,
      confidence REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      entities_json TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      session_ids_json TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_vectors_model ON memory_vectors (model, model_version, dimensions);
    CREATE INDEX IF NOT EXISTS idx_memory_vectors_current ON memory_vectors (status, type, source_type, confidence, created_at);
  `);
}

/**
 * A reliable local fallback while sqlite-vec is not an installed compatible
 * better-sqlite3 extension. It scans only derived vector rows, applies metadata
 * in SQLite/row metadata, and hydrates canonical Memory only after Top-K IDs.
 */
export class SqliteMemoryVectorStore implements MemoryVectorStore {
  private readonly db: Database.Database;

  constructor(filename: string) {
    this.db = openVectorDatabase(filename);
    migrateVectors(this.db);
  }

  async get(memoryId: string): Promise<MemoryVectorRecord | undefined> {
    const row = this.db.prepare("SELECT * FROM memory_vectors WHERE memory_id = ?").get(memoryId) as StoredVector | undefined;
    return row === undefined ? undefined : this.toRecord(row);
  }

  async upsert(record: MemoryVectorRecord): Promise<void> {
    this.insert(record);
  }

  async search(query: MemoryVectorSearchQuery): Promise<readonly MemoryVectorSearchHit[]> {
    const descriptor = embeddingModelDescriptorSchema.parse(query.descriptor);
    if (query.values.length !== descriptor.dimensions || query.limit < 1) return [];
    const filters = query.filters ?? {};
    const sql = this.filterSql(filters);
    const rows = this.db.prepare(`
      SELECT * FROM memory_vectors
      WHERE model = ? AND model_version = ? AND dimensions = ?${sql.clauses.length === 0 ? "" : ` AND ${sql.clauses.join(" AND ")}`}
    `).all(descriptor.model, descriptor.version, descriptor.dimensions, ...sql.parameters) as StoredVector[];
    return rows
      .map((row) => ({ memoryId: row.memory_id, score: cosine(query.values, JSON.parse(row.values_json) as number[]) }))
      .sort((left, right) => right.score - left.score || left.memoryId.localeCompare(right.memoryId))
      .slice(0, query.limit);
  }

  async replaceAll(records: readonly MemoryVectorRecord[]): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM memory_vectors").run();
      for (const record of records) this.insert(record);
    })();
  }

  async clear(): Promise<void> {
    this.db.prepare("DELETE FROM memory_vectors").run();
  }

  async count(): Promise<number> {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM memory_vectors").get() as { count: number }).count);
  }

  close(): void {
    this.db.close();
  }

  private insert(record: MemoryVectorRecord): void {
    const parsed = memoryVectorRecordSchema.parse(record);
    this.db.prepare(`
      INSERT INTO memory_vectors (
        memory_id, values_json, dimensions, model, model_version, content_hash,
        type, status, source_type, confidence, created_at, updated_at,
        entities_json, tags_json, session_ids_json, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        values_json = excluded.values_json,
        dimensions = excluded.dimensions,
        model = excluded.model,
        model_version = excluded.model_version,
        content_hash = excluded.content_hash,
        type = excluded.type,
        status = excluded.status,
        source_type = excluded.source_type,
        confidence = excluded.confidence,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        entities_json = excluded.entities_json,
        tags_json = excluded.tags_json,
        session_ids_json = excluded.session_ids_json,
        indexed_at = excluded.indexed_at
    `).run(
      parsed.memoryId,
      JSON.stringify(parsed.values),
      parsed.dimensions,
      parsed.model,
      parsed.modelVersion,
      parsed.contentHash,
      parsed.type,
      parsed.status,
      parsed.sourceType,
      parsed.confidence,
      parsed.createdAt,
      parsed.updatedAt,
      JSON.stringify(parsed.entities),
      JSON.stringify(parsed.tags),
      JSON.stringify(parsed.sessionIds),
      parsed.indexedAt,
    );
  }

  private filterSql(filters: MemoryVectorFilters): { clauses: string[]; parameters: unknown[] } {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (filters.statuses && filters.statuses.length > 0) {
      clauses.push(`status IN (${filters.statuses.map(() => "?").join(", ")})`);
      parameters.push(...filters.statuses);
    }
    if (filters.types && filters.types.length > 0) {
      clauses.push(`type IN (${filters.types.map(() => "?").join(", ")})`);
      parameters.push(...filters.types);
    }
    if (filters.sourceTypes && filters.sourceTypes.length > 0) {
      clauses.push(`source_type IN (${filters.sourceTypes.map(() => "?").join(", ")})`);
      parameters.push(...filters.sourceTypes);
    }
    if (filters.minimumConfidence !== undefined) {
      clauses.push("confidence >= ?");
      parameters.push(filters.minimumConfidence);
    }
    if (filters.before !== undefined) {
      clauses.push("created_at <= ?");
      parameters.push(filters.before);
    }
    if (filters.after !== undefined) {
      clauses.push("created_at >= ?");
      parameters.push(filters.after);
    }
    if (filters.sessionId !== undefined) {
      clauses.push("session_ids_json LIKE ?");
      parameters.push(`%${JSON.stringify(filters.sessionId)}%`);
    }
    // Entity/tag JSON metadata remains small and derived. The canonical record is checked again after hydration.
    if (filters.entities && filters.entities.length > 0) {
      clauses.push(`(${filters.entities.map(() => "LOWER(entities_json) LIKE ?").join(" OR ")})`);
      parameters.push(...filters.entities.map((entity) => `%${JSON.stringify(entity.toLocaleLowerCase())}%`));
    }
    if (filters.tags && filters.tags.length > 0) {
      clauses.push(`(${filters.tags.map(() => "LOWER(tags_json) LIKE ?").join(" OR ")})`);
      parameters.push(...filters.tags.map((tag) => `%${JSON.stringify(tag.toLocaleLowerCase())}%`));
    }
    return { clauses, parameters };
  }

  private toRecord(row: StoredVector): MemoryVectorRecord {
    return memoryVectorRecordSchema.parse({
      memoryId: row.memory_id,
      values: JSON.parse(row.values_json) as unknown,
      dimensions: row.dimensions,
      model: row.model,
      modelVersion: row.model_version,
      contentHash: row.content_hash,
      type: row.type,
      status: row.status,
      sourceType: row.source_type,
      confidence: row.confidence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      entities: JSON.parse(row.entities_json) as unknown,
      tags: JSON.parse(row.tags_json) as unknown,
      sessionIds: JSON.parse(row.session_ids_json) as unknown,
      indexedAt: row.indexed_at,
    });
  }
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return leftNorm === 0 || rightNorm === 0 ? -1 : dot / Math.sqrt(leftNorm * rightNorm);
}
