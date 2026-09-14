import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  memoryCreateInputSchema,
  memoryIdSchema,
  memoryListQuerySchema,
  memoryRecordSchema,
  memorySearchQuerySchema,
  memoryTimelineQuerySchema,
  memoryUpdateInputSchema,
  type MemoryCreateInput,
  type MemoryListQuery,
  type MemoryRecord,
  type MemorySearchQuery,
  type MemorySearchResult,
  type MemorySourceReference,
  type MemoryStatus,
  type MemoryStore,
  type MemoryTimelineQuery,
  type MemoryType,
  type MemoryUpdateInput,
} from "@mnemos/core";

interface StoredMemory {
  rowid: number;
  id: string;
  type: MemoryType;
  content: string;
  created_at: string;
  updated_at: string;
  last_confirmed_at: string | null;
  importance: number;
  confidence: number;
  source_type: MemoryRecord["sourceType"];
  status: MemoryStatus;
  superseded_by: string | null;
  merged_into: string | null;
  derived_from_memory_ids: string;
  confirmation_count: number;
  reinforcement_score: number;
  last_reinforced_at: string | null;
  stale: number;
  stale_since: string | null;
  durability: MemoryRecord["durability"];
  scope_kind: MemoryRecord["scope"]["kind"];
  scope_id: string;
  entity_relations: string;
}

interface SearchRow extends StoredMemory {
  score: number;
}

function openMemoryDatabase(filename: string): Database.Database {
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function migrateMemory(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_records (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('semantic', 'episodic', 'decision', 'preference', 'entity')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_confirmed_at TEXT,
      importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      source_type TEXT NOT NULL CHECK (source_type IN ('explicit_user_statement', 'tool_observation', 'assistant_inference', 'derived_summary')),
      status TEXT NOT NULL CHECK (status IN ('active', 'provisional', 'superseded', 'archived')),
      superseded_by TEXT REFERENCES memory_records(id),
      merged_into TEXT REFERENCES memory_records(id),
      derived_from_memory_ids TEXT NOT NULL DEFAULT '[]',
      confirmation_count INTEGER NOT NULL DEFAULT 1 CHECK (confirmation_count >= 0),
      reinforcement_score REAL NOT NULL DEFAULT 0 CHECK (reinforcement_score >= 0 AND reinforcement_score <= 1),
      last_reinforced_at TEXT,
      stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
      stale_since TEXT,
      durability TEXT NOT NULL DEFAULT 'normal' CHECK (durability IN ('durable', 'normal', 'ephemeral')),
      scope_kind TEXT NOT NULL DEFAULT 'global' CHECK (scope_kind IN ('global', 'user', 'project', 'session', 'entity')),
      scope_id TEXT NOT NULL DEFAULT 'global',
      entity_relations TEXT NOT NULL DEFAULT '[]',
      CHECK ((status = 'superseded' AND superseded_by IS NOT NULL) OR (status <> 'superseded' AND superseded_by IS NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_memory_records_status_type_updated
      ON memory_records (status, type, updated_at DESC);
    CREATE TABLE IF NOT EXISTS memory_sources (
      memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (memory_id, session_id, message_id),
      UNIQUE (memory_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_sources_message
      ON memory_sources (session_id, message_id);
    CREATE TABLE IF NOT EXISTS memory_entities (
      memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
      entity TEXT NOT NULL,
      PRIMARY KEY (memory_id, entity)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_entities_entity
      ON memory_entities (entity);
    CREATE TABLE IF NOT EXISTS memory_tags (
      memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (memory_id, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_tags_tag
      ON memory_tags (tag);
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      content,
      content='memory_records',
      content_rowid='rowid',
      tokenize='unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS memory_records_ai AFTER INSERT ON memory_records BEGIN
      INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_records_ad AFTER DELETE ON memory_records BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_records_au AFTER UPDATE OF content ON memory_records BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);
  const columns = db.prepare("PRAGMA table_info(memory_records)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));
  const additions: Array<[string, string]> = [
    ["merged_into", "TEXT REFERENCES memory_records(id)"],
    ["derived_from_memory_ids", "TEXT NOT NULL DEFAULT '[]'"],
    ["confirmation_count", "INTEGER NOT NULL DEFAULT 1"],
    ["reinforcement_score", "REAL NOT NULL DEFAULT 0"],
    ["last_reinforced_at", "TEXT"],
    ["stale", "INTEGER NOT NULL DEFAULT 0"],
    ["stale_since", "TEXT"],
    ["durability", "TEXT NOT NULL DEFAULT 'normal'"],
    ["scope_kind", "TEXT NOT NULL DEFAULT 'global'"],
    ["scope_id", "TEXT NOT NULL DEFAULT 'global'"],
    ["entity_relations", "TEXT NOT NULL DEFAULT '[]'"],
  ];
  for (const [name, definition] of additions) {
    if (!existing.has(name)) db.exec(`ALTER TABLE memory_records ADD COLUMN ${name} ${definition}`);
  }
}

/** SQLite + FTS5 implementation of the Phase 3 MemoryStore contract. */
export class SqliteMemoryStore implements MemoryStore {
  private readonly db: Database.Database;

  constructor(filename: string) {
    this.db = openMemoryDatabase(filename);
    migrateMemory(this.db);
  }

  async create(input: MemoryCreateInput): Promise<MemoryRecord> {
    const parsed = memoryCreateInputSchema.parse(input);
    const record = this.db.transaction(() => {
      const now = new Date().toISOString();
      const id = parsed.id ?? randomUUID();
      this.db.prepare(`
        INSERT INTO memory_records (
          id, type, content, created_at, updated_at, last_confirmed_at,
          importance, confidence, source_type, status, superseded_by, merged_into,
          derived_from_memory_ids, confirmation_count, reinforcement_score, last_reinforced_at,
          stale, stale_since, durability, scope_kind, scope_id, entity_relations
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        parsed.type,
        parsed.content,
        parsed.createdAt ?? now,
        parsed.createdAt ?? now,
        parsed.lastConfirmedAt ?? null,
        parsed.importance,
        parsed.confidence,
        parsed.sourceType,
        parsed.status,
        parsed.mergedInto ?? null,
        JSON.stringify(parsed.derivedFromMemoryIds),
        parsed.confirmationCount,
        parsed.reinforcementScore,
        parsed.lastReinforcedAt ?? null,
        parsed.stale ? 1 : 0,
        parsed.staleSince ?? null,
        parsed.durability,
        parsed.scope.kind,
        parsed.scope.id,
        JSON.stringify(parsed.entityRelations),
      );
      this.replaceSources(id, parsed.sourceReferences);
      this.replaceValues("memory_entities", "entity", id, parsed.entities);
      this.replaceValues("memory_tags", "tag", id, parsed.tags);
      return this.requireRecord(id);
    })();
    return record;
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    return this.readRecord(memoryIdSchema.parse(id));
  }

  async getMany(ids: readonly string[]): Promise<MemoryRecord[]> {
    const byId = new Map<string, MemoryRecord>();
    for (const id of ids) {
      const parsedId = memoryIdSchema.parse(id);
      const record = this.readRecord(parsedId);
      if (record) byId.set(parsedId, record);
    }
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  async update(id: string, update: MemoryUpdateInput): Promise<MemoryRecord> {
    const memoryId = memoryIdSchema.parse(id);
    const parsed = memoryUpdateInputSchema.parse(update);
    return this.db.transaction(() => {
      const current = this.requireRecord(memoryId);
      if (current.status === "superseded" && parsed.status !== undefined) {
        throw new Error("Superseded memory status can only be changed through a new successor relation");
      }
      const assignments: string[] = ["updated_at = ?"];
      const parameters: unknown[] = [new Date().toISOString()];
      if (parsed.type !== undefined) { assignments.push("type = ?"); parameters.push(parsed.type); }
      if (parsed.content !== undefined) { assignments.push("content = ?"); parameters.push(parsed.content); }
      if (parsed.lastConfirmedAt !== undefined) { assignments.push("last_confirmed_at = ?"); parameters.push(parsed.lastConfirmedAt); }
      if (parsed.importance !== undefined) { assignments.push("importance = ?"); parameters.push(parsed.importance); }
      if (parsed.confidence !== undefined) { assignments.push("confidence = ?"); parameters.push(parsed.confidence); }
      if (parsed.sourceType !== undefined) { assignments.push("source_type = ?"); parameters.push(parsed.sourceType); }
      if (parsed.status !== undefined) { assignments.push("status = ?"); parameters.push(parsed.status); }
      if (parsed.mergedInto !== undefined) { assignments.push("merged_into = ?"); parameters.push(parsed.mergedInto); }
      if (parsed.derivedFromMemoryIds !== undefined) { assignments.push("derived_from_memory_ids = ?"); parameters.push(JSON.stringify(parsed.derivedFromMemoryIds)); }
      if (parsed.confirmationCount !== undefined) { assignments.push("confirmation_count = ?"); parameters.push(parsed.confirmationCount); }
      if (parsed.reinforcementScore !== undefined) { assignments.push("reinforcement_score = ?"); parameters.push(parsed.reinforcementScore); }
      if (parsed.lastReinforcedAt !== undefined) { assignments.push("last_reinforced_at = ?"); parameters.push(parsed.lastReinforcedAt); }
      if (parsed.stale !== undefined) { assignments.push("stale = ?"); parameters.push(parsed.stale ? 1 : 0); }
      if (parsed.staleSince !== undefined) { assignments.push("stale_since = ?"); parameters.push(parsed.staleSince); }
      if (parsed.durability !== undefined) { assignments.push("durability = ?"); parameters.push(parsed.durability); }
      if (parsed.scope !== undefined) {
        assignments.push("scope_kind = ?", "scope_id = ?");
        parameters.push(parsed.scope.kind, parsed.scope.id);
      }
      if (parsed.entityRelations !== undefined) { assignments.push("entity_relations = ?"); parameters.push(JSON.stringify(parsed.entityRelations)); }
      parameters.push(memoryId);
      this.db.prepare(`UPDATE memory_records SET ${assignments.join(", ")} WHERE id = ?`).run(...parameters);
      if (parsed.sourceReferences !== undefined) this.replaceSources(memoryId, parsed.sourceReferences);
      if (parsed.entities !== undefined) this.replaceValues("memory_entities", "entity", memoryId, parsed.entities);
      if (parsed.tags !== undefined) this.replaceValues("memory_tags", "tag", memoryId, parsed.tags);
      return this.requireRecord(memoryId);
    })();
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchResult[]> {
    const parsed = memorySearchQuerySchema.parse(query);
    const filters = this.filters(parsed, ["active"]);
    const rows = this.db.prepare(`
      SELECT m.rowid, m.*, bm25(memory_fts) AS score
      FROM memory_fts
      JOIN memory_records m ON m.rowid = memory_fts.rowid
      WHERE memory_fts MATCH ? ${filters.clauses.length > 0 ? `AND ${filters.clauses.join(" AND ")}` : ""}
      ORDER BY
        CASE m.status WHEN 'active' THEN 0 WHEN 'provisional' THEN 1 WHEN 'superseded' THEN 2 ELSE 3 END,
        score ASC,
        m.updated_at DESC,
        m.rowid DESC
      LIMIT ?
    `).all(this.toFtsQuery(parsed.query), ...filters.parameters, parsed.limit) as SearchRow[];
    return rows.map((row) => ({ memory: this.toRecord(row), score: Number(row.score) }));
  }

  async list(query: MemoryListQuery = {}): Promise<MemoryRecord[]> {
    const parsed = memoryListQuerySchema.parse(query);
    const filters = this.filters(parsed);
    const rows = this.db.prepare(`
      SELECT rowid, * FROM memory_records m
      ${filters.clauses.length > 0 ? `WHERE ${filters.clauses.join(" AND ")}` : ""}
      ORDER BY m.created_at ASC, m.rowid ASC
      LIMIT ?
    `).all(...filters.parameters, parsed.limit) as StoredMemory[];
    return rows.map((row) => this.toRecord(row));
  }

  async supersede(supersededId: string, replacementId: string): Promise<{ superseded: MemoryRecord; replacement: MemoryRecord }> {
    const previousId = memoryIdSchema.parse(supersededId);
    const successorId = memoryIdSchema.parse(replacementId);
    if (previousId === successorId) throw new Error("A Memory record cannot supersede itself");
    return this.db.transaction(() => {
      const superseded = this.requireRecord(previousId);
      const replacement = this.requireRecord(successorId);
      if (superseded.status === "superseded") throw new Error("Memory already has a successor");
      if (superseded.status === "archived") throw new Error("Archived Memory cannot be superseded");
      if (replacement.status !== "active" && replacement.status !== "provisional") {
        throw new Error("A replacement Memory must be active or provisional");
      }
      this.db.prepare(`
        UPDATE memory_records
        SET status = 'superseded', superseded_by = ?, updated_at = ?
        WHERE id = ?
      `).run(successorId, new Date().toISOString(), previousId);
      return { superseded: this.requireRecord(previousId), replacement: this.requireRecord(successorId) };
    })();
  }

  async timeline(query: MemoryTimelineQuery): Promise<MemoryRecord[]> {
    const parsed = memoryTimelineQuerySchema.parse(query);
    const filters = this.filters(parsed);
    if (parsed.entity !== undefined) {
      filters.clauses.push("EXISTS (SELECT 1 FROM memory_entities timeline_entity WHERE timeline_entity.memory_id = m.id AND LOWER(timeline_entity.entity) = ?)");
      filters.parameters.push(parsed.entity.trim().toLowerCase());
    }
    if (parsed.tag !== undefined) {
      filters.clauses.push("EXISTS (SELECT 1 FROM memory_tags timeline_tag WHERE timeline_tag.memory_id = m.id AND LOWER(timeline_tag.tag) = ?)");
      filters.parameters.push(parsed.tag.trim().toLowerCase());
    }
    const rows = this.db.prepare(`
      SELECT rowid, * FROM memory_records m
      WHERE ${filters.clauses.join(" AND ")}
      ORDER BY m.created_at ASC, m.rowid ASC
      LIMIT ?
    `).all(...filters.parameters, parsed.limit) as StoredMemory[];
    return rows.map((row) => this.toRecord(row));
  }

  close(): void {
    this.db.close();
  }

  private requireRecord(id: string): MemoryRecord {
    const record = this.readRecord(id);
    if (!record) throw new Error(`Memory not found: ${id}`);
    return record;
  }

  private readRecord(id: string): MemoryRecord | undefined {
    const row = this.db.prepare("SELECT rowid, * FROM memory_records WHERE id = ?").get(id) as StoredMemory | undefined;
    return row === undefined ? undefined : this.toRecord(row);
  }

  private toRecord(row: StoredMemory): MemoryRecord {
    const sourceReferences = this.db.prepare(`
      SELECT session_id AS sessionId, message_id AS messageId
      FROM memory_sources WHERE memory_id = ? ORDER BY ordinal ASC
    `).all(row.id) as MemorySourceReference[];
    const entities = (this.db.prepare("SELECT entity FROM memory_entities WHERE memory_id = ? ORDER BY entity ASC").all(row.id) as Array<{ entity: string }>).map((entry) => entry.entity);
    const tags = (this.db.prepare("SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY tag ASC").all(row.id) as Array<{ tag: string }>).map((entry) => entry.tag);
    return memoryRecordSchema.parse({
      id: row.id,
      type: row.type,
      content: row.content,
      sourceIds: sourceReferences.map((source) => source.messageId),
      sourceReferences,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.last_confirmed_at === null ? {} : { lastConfirmedAt: row.last_confirmed_at }),
      importance: row.importance,
      confidence: row.confidence,
      sourceType: row.source_type,
      status: row.status,
      ...(row.superseded_by === null ? {} : { supersededBy: row.superseded_by }),
      ...(row.merged_into === null ? {} : { mergedInto: row.merged_into }),
      derivedFromMemoryIds: JSON.parse(row.derived_from_memory_ids ?? "[]") as unknown,
      confirmationCount: row.confirmation_count,
      reinforcementScore: row.reinforcement_score,
      ...(row.last_reinforced_at === null ? {} : { lastReinforcedAt: row.last_reinforced_at }),
      stale: row.stale === 1,
      ...(row.stale_since === null ? {} : { staleSince: row.stale_since }),
      durability: row.durability,
      scope: { kind: row.scope_kind, id: row.scope_id },
      entityRelations: JSON.parse(row.entity_relations ?? "[]") as unknown,
      entities,
      tags,
    });
  }

  private replaceSources(memoryId: string, sources: readonly MemorySourceReference[]): void {
    this.db.prepare("DELETE FROM memory_sources WHERE memory_id = ?").run(memoryId);
    const insert = this.db.prepare(`
      INSERT INTO memory_sources (memory_id, session_id, message_id, ordinal) VALUES (?, ?, ?, ?)
    `);
    sources.forEach((source, ordinal) => insert.run(memoryId, source.sessionId, source.messageId, ordinal));
  }

  private replaceValues(table: "memory_entities" | "memory_tags", column: "entity" | "tag", memoryId: string, values: readonly string[]): void {
    this.db.prepare(`DELETE FROM ${table} WHERE memory_id = ?`).run(memoryId);
    const insert = this.db.prepare(`INSERT INTO ${table} (memory_id, ${column}) VALUES (?, ?)`);
    for (const value of new Set(values.map((value) => value.trim()))) insert.run(memoryId, value);
  }

  private filters(query: Pick<MemoryListQuery, "types" | "statuses" | "sourceTypes" | "entities" | "tags" | "minimumConfidence" | "before" | "after" | "sessionId" | "scopeKind" | "scopeId">, defaultStatuses?: readonly MemoryStatus[]): { clauses: string[]; parameters: unknown[] } {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    const statuses = query.statuses ?? defaultStatuses;
    if (statuses && statuses.length > 0) {
      clauses.push(`m.status IN (${statuses.map(() => "?").join(", ")})`);
      parameters.push(...statuses);
    }
    if (query.types && query.types.length > 0) {
      clauses.push(`m.type IN (${query.types.map(() => "?").join(", ")})`);
      parameters.push(...query.types);
    }
    if (query.sourceTypes && query.sourceTypes.length > 0) {
      clauses.push(`m.source_type IN (${query.sourceTypes.map(() => "?").join(", ")})`);
      parameters.push(...query.sourceTypes);
    }
    if (query.minimumConfidence !== undefined) {
      clauses.push("m.confidence >= ?");
      parameters.push(query.minimumConfidence);
    }
    if (query.before !== undefined) {
      clauses.push("m.created_at <= ?");
      parameters.push(query.before);
    }
    if (query.after !== undefined) {
      clauses.push("m.created_at >= ?");
      parameters.push(query.after);
    }
    if (query.sessionId !== undefined) {
      clauses.push("EXISTS (SELECT 1 FROM memory_sources filter_session WHERE filter_session.memory_id = m.id AND filter_session.session_id = ?)");
      parameters.push(query.sessionId);
    }
    if (query.scopeKind !== undefined) {
      clauses.push("m.scope_kind = ?");
      parameters.push(query.scopeKind);
    }
    if (query.scopeId !== undefined) {
      clauses.push("m.scope_id = ?");
      parameters.push(query.scopeId);
    }
    if (query.entities && query.entities.length > 0) {
      clauses.push(`EXISTS (SELECT 1 FROM memory_entities filter_entity WHERE filter_entity.memory_id = m.id AND LOWER(filter_entity.entity) IN (${query.entities.map(() => "?").join(", ")}))`);
      parameters.push(...query.entities.map((entity) => entity.trim().toLowerCase()));
    }
    if (query.tags && query.tags.length > 0) {
      clauses.push(`EXISTS (SELECT 1 FROM memory_tags filter_tag WHERE filter_tag.memory_id = m.id AND LOWER(filter_tag.tag) IN (${query.tags.map(() => "?").join(", ")}))`);
      parameters.push(...query.tags.map((tag) => tag.trim().toLowerCase()));
    }
    return { clauses, parameters };
  }

  private toFtsQuery(query: string): string {
    return query.trim().split(/\s+/).map((term) => `"${term.replaceAll("\"", "\"\"")}"`).join(" AND ");
  }
}
