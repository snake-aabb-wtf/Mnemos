import Database from "better-sqlite3";
import {
  canonicalizeEntityName,
  entityIdForName,
  memoryEntityRelationSchema,
  type EntityGraphStore,
  type MemoryEntityGraphEntity,
  type MemoryEntityGraphRelation,
  type MemoryRecord,
  type MemorySourceReference,
} from "@mnemos/core";

interface StoredEntity {
  id: string;
  canonical_name: string;
  aliases: string;
  created_at: string;
  updated_at: string;
}

interface StoredRelation {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  relation: string;
  memory_ids: string;
  source_references: string;
  scope_kind: string;
  scope_id: string;
  created_at: string;
  updated_at: string;
}

function open(filename: string): Database.Database {
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_graph_entities (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL UNIQUE,
      aliases TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_graph_relations (
      id TEXT PRIMARY KEY,
      from_entity_id TEXT NOT NULL REFERENCES memory_graph_entities(id) ON DELETE CASCADE,
      to_entity_id TEXT NOT NULL REFERENCES memory_graph_entities(id) ON DELETE CASCADE,
      relation TEXT NOT NULL,
      memory_ids TEXT NOT NULL DEFAULT '[]',
      source_references TEXT NOT NULL DEFAULT '[]',
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(from_entity_id, to_entity_id, relation, scope_kind, scope_id)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_graph_relations_from ON memory_graph_relations(from_entity_id);
    CREATE INDEX IF NOT EXISTS idx_memory_graph_relations_to ON memory_graph_relations(to_entity_id);
  `);
  return db;
}

/** Rebuildable SQLite projection of Memory entity metadata and relationships. */
export class SqliteEntityGraphStore implements EntityGraphStore {
  private readonly db: Database.Database;

  constructor(filename: string) {
    this.db = open(filename);
  }

  async upsertMemory(memory: MemoryRecord): Promise<void> {
    this.db.transaction(() => {
      const names = new Set<string>(memory.entities);
      for (const relation of memory.entityRelations) {
        names.add(relation.from);
        names.add(relation.to);
      }
      const now = new Date().toISOString();
      for (const name of names) this.upsertEntity(name, now);
      for (const relation of memory.entityRelations) {
        const parsed = memoryEntityRelationSchema.parse(relation);
        const fromId = entityIdForName(parsed.from);
        const toId = entityIdForName(parsed.to);
        const id = entityIdForName(`${memory.scope.kind}:${memory.scope.id}:${parsed.from}:${parsed.relation}:${parsed.to}`);
        const existing = this.db.prepare("SELECT * FROM memory_graph_relations WHERE id = ?").get(id) as StoredRelation | undefined;
        const memoryIds = unique([...parseJson<string[]>(existing?.memory_ids, []), memory.id]);
        const sourceReferences = uniqueSources([
          ...parseJson<MemorySourceReference[]>(existing?.source_references, []),
          ...memory.sourceReferences,
        ]);
        this.db.prepare(`
          INSERT INTO memory_graph_relations (
            id, from_entity_id, to_entity_id, relation, memory_ids, source_references,
            scope_kind, scope_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            memory_ids = excluded.memory_ids,
            source_references = excluded.source_references,
            updated_at = excluded.updated_at
        `).run(
          id, fromId, toId, parsed.relation, JSON.stringify(memoryIds), JSON.stringify(sourceReferences),
          memory.scope.kind, memory.scope.id, existing?.created_at ?? now, now,
        );
      }
    })();
  }

  async listEntities(): Promise<readonly MemoryEntityGraphEntity[]> {
    const rows = this.db.prepare("SELECT * FROM memory_graph_entities ORDER BY canonical_name ASC").all() as StoredEntity[];
    return rows.map((row) => ({
      id: row.id,
      canonicalName: row.canonical_name,
      aliases: parseJson<string[]>(row.aliases, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async listRelations(): Promise<readonly MemoryEntityGraphRelation[]> {
    const rows = this.db.prepare("SELECT * FROM memory_graph_relations ORDER BY created_at ASC, id ASC").all() as StoredRelation[];
    return rows.map((row) => ({
      id: row.id,
      fromEntityId: row.from_entity_id,
      toEntityId: row.to_entity_id,
      relation: row.relation as MemoryEntityGraphRelation["relation"],
      memoryIds: parseJson<string[]>(row.memory_ids, []),
      sourceReferences: parseJson<MemorySourceReference[]>(row.source_references, []),
      scope: { kind: row.scope_kind as MemoryRecord["scope"]["kind"], id: row.scope_id },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async clear(): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM memory_graph_relations").run();
      this.db.prepare("DELETE FROM memory_graph_entities").run();
    })();
  }

  close(): void {
    this.db.close();
  }

  private upsertEntity(name: string, now: string): void {
    const canonicalName = canonicalizeEntityName(name);
    const id = entityIdForName(canonicalName);
    const existing = this.db.prepare("SELECT * FROM memory_graph_entities WHERE id = ?").get(id) as StoredEntity | undefined;
    const aliases = unique([...parseJson<string[]>(existing?.aliases, []), name.trim(), canonicalName]);
    this.db.prepare(`
      INSERT INTO memory_graph_entities (id, canonical_name, aliases, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET aliases = excluded.aliases, updated_at = excluded.updated_at
    `).run(id, canonicalName, JSON.stringify(aliases), existing?.created_at ?? now, now);
  }
}

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (value === undefined) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqueSources(values: readonly MemorySourceReference[]): MemorySourceReference[] {
  const map = new Map<string, MemorySourceReference>();
  for (const source of values) map.set(`${source.sessionId}:${source.messageId}`, source);
  return [...map.values()];
}
