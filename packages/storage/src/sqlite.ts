import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  historyMessageSchema,
  contextCompactionCheckpointSchema,
  type ContextCompactionCheckpoint,
  type ContextCompactionStore,
  type HistoryMessage,
  type HistoryStore,
  type NewHistoryMessage,
  type StateStore,
} from "@mnemos/core";

interface StoredMessage {
  id: string;
  session_id: string;
  role: HistoryMessage["role"];
  content: string;
  created_at: string;
  metadata: string | null;
}

interface StoredState {
  session_id: string;
  value: string;
  updated_at: string;
}

interface StoredCompactionCheckpoint {
  session_id: string;
  evicted_through_message_id: string | null;
  automatic_pin: string | null;
  updated_at: string;
}

function openDatabase(filename: string): Database.Database {
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function migrateHistory(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_history_messages_session_created
      ON history_messages (session_id, created_at);
  `);
}

function migrateState(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS working_state (
      session_id TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function migrateCompaction(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_compaction_checkpoints (
      session_id TEXT PRIMARY KEY,
      evicted_through_message_id TEXT,
      automatic_pin TEXT,
      updated_at TEXT NOT NULL
    );
  `);
}

/** SQLite-backed, append-only canonical History implementation. */
export class SqliteHistoryStore implements HistoryStore {
  private readonly db: Database.Database;

  constructor(filename: string) {
    this.db = openDatabase(filename);
    migrateHistory(this.db);
  }

  async append(message: NewHistoryMessage): Promise<HistoryMessage> {
    const stored: HistoryMessage = {
      id: message.id ?? randomUUID(),
      sessionId: message.sessionId,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt ?? new Date().toISOString(),
      ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
    };
    this.db.prepare(`
      INSERT INTO history_messages (id, session_id, role, content, created_at, metadata)
      VALUES (@id, @sessionId, @role, @content, @createdAt, @metadata)
    `).run({ ...stored, metadata: stored.metadata === undefined ? null : JSON.stringify(stored.metadata) });
    return historyMessageSchema.parse(stored);
  }

  async get(sessionId: string, messageId: string): Promise<HistoryMessage | undefined> {
    const row = this.db.prepare(`
      SELECT id, session_id, role, content, created_at, metadata
      FROM history_messages WHERE session_id = ? AND id = ?
    `).get(sessionId, messageId) as StoredMessage | undefined;
    return row === undefined ? undefined : this.toMessage(row);
  }

  async list(sessionId: string, options: { limit?: number } = {}): Promise<HistoryMessage[]> {
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) {
      throw new Error("History list limit must be a non-negative integer");
    }
    const rows = options.limit === undefined
      ? this.db.prepare(`SELECT id, session_id, role, content, created_at, metadata FROM history_messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`).all(sessionId)
      : this.db.prepare(`SELECT id, session_id, role, content, created_at, metadata FROM (SELECT id, session_id, role, content, created_at, metadata, rowid FROM history_messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at ASC, rowid ASC`).all(sessionId, options.limit);
    return (rows as StoredMessage[]).map((row) => this.toMessage(row));
  }

  close(): void {
    this.db.close();
  }

  private toMessage(row: StoredMessage): HistoryMessage {
    return historyMessageSchema.parse({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
      ...(row.metadata === null ? {} : { metadata: JSON.parse(row.metadata) as Record<string, unknown> }),
    });
  }
}

/** SQLite-backed mutable State implementation, deliberately separate from History. */
export class SqliteStateStore implements StateStore {
  private readonly db: Database.Database;

  constructor(filename: string) {
    this.db = openDatabase(filename);
    migrateState(this.db);
  }

  async get<T extends Record<string, unknown>>(sessionId: string): Promise<T | undefined> {
    const row = this.db.prepare("SELECT session_id, value, updated_at FROM working_state WHERE session_id = ?").get(sessionId) as StoredState | undefined;
    return row === undefined ? undefined : JSON.parse(row.value) as T;
  }

  async set<T extends Record<string, unknown>>(sessionId: string, state: T): Promise<T> {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO working_state (session_id, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(sessionId, JSON.stringify(state), updatedAt);
    return state;
  }

  async patch<T extends Record<string, unknown>>(sessionId: string, patch: Partial<T>): Promise<T> {
    const current = await this.get<T>(sessionId);
    return this.set(sessionId, { ...(current ?? {}), ...patch } as T);
  }

  close(): void {
    this.db.close();
  }
}

/** Durable session cursor and automatic pin for the Phase 2 compaction pipeline. */
export class SqliteContextCompactionStore implements ContextCompactionStore {
  private readonly db: Database.Database;

  constructor(filename: string) {
    this.db = openDatabase(filename);
    migrateCompaction(this.db);
  }

  async get(sessionId: string): Promise<ContextCompactionCheckpoint | undefined> {
    const row = this.db.prepare(`
      SELECT session_id, evicted_through_message_id, automatic_pin, updated_at
      FROM context_compaction_checkpoints WHERE session_id = ?
    `).get(sessionId) as StoredCompactionCheckpoint | undefined;
    if (!row) return undefined;
    return contextCompactionCheckpointSchema.parse({
      sessionId: row.session_id,
      ...(row.evicted_through_message_id === null ? {} : { evictedThroughMessageId: row.evicted_through_message_id }),
      ...(row.automatic_pin === null ? {} : { automaticPin: JSON.parse(row.automatic_pin) }),
      updatedAt: row.updated_at,
    });
  }

  async set(checkpoint: ContextCompactionCheckpoint): Promise<void> {
    this.db.prepare(`
      INSERT INTO context_compaction_checkpoints (session_id, evicted_through_message_id, automatic_pin, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        evicted_through_message_id = excluded.evicted_through_message_id,
        automatic_pin = excluded.automatic_pin,
        updated_at = excluded.updated_at
    `).run(
      checkpoint.sessionId,
      checkpoint.evictedThroughMessageId ?? null,
      checkpoint.automaticPin === undefined ? null : JSON.stringify(checkpoint.automaticPin),
      checkpoint.updatedAt,
    );
  }

  close(): void {
    this.db.close();
  }
}
