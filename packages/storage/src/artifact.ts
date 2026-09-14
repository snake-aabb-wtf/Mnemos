import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  ArtifactBodyMissingError,
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  ArtifactQuotaExceededError,
  ArtifactQueryUnsupportedError,
  artifactCreateOptionsSchema,
  artifactIdSchema,
  artifactQueryMatchSchema,
  artifactQueryOptionsSchema,
  artifactReadOptionsSchema,
  artifactRecordSchema,
  type ArtifactContent,
  type ArtifactCreateInput,
  type ArtifactId,
  type ArtifactQueryMatch,
  type ArtifactQueryOptions,
  type ArtifactReadOptions,
  type ArtifactRecord,
  type ArtifactRecoveryReport,
  type ArtifactStore,
} from "@mnemos/core";

interface StoredArtifact {
  id: string;
  session_id: string | null;
  scope: "session" | "persistent";
  type: string;
  mime_type: string | null;
  size_bytes: number;
  storage_location: string;
  sha256: string;
  summary: string | null;
  display_name: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

interface StoredTextLine {
  byte_offset: number;
  line_number: number;
  content: string;
}

export interface SqliteArtifactStoreOptions {
  /** SQLite database that owns Artifact metadata and the derived text index. */
  databasePath: string;
  /** Private directory for immutable Artifact bodies. It is not a user-visible path API. */
  storageDirectory: string;
  /** Maximum committed body bytes; zero/undefined means unlimited. */
  maxStorageBytes?: number;
}

function openArtifactDatabase(filename: string): Database.Database {
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  return db;
}

function migrateArtifactStore(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifact_records (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      scope TEXT NOT NULL CHECK (scope IN ('session', 'persistent')),
      type TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      storage_location TEXT NOT NULL UNIQUE,
      sha256 TEXT NOT NULL,
      summary TEXT,
      display_name TEXT,
      metadata TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      CHECK ((scope = 'session' AND session_id IS NOT NULL) OR scope = 'persistent')
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_records_expiry ON artifact_records (expires_at);
    CREATE INDEX IF NOT EXISTS idx_artifact_records_session ON artifact_records (session_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS artifact_text_lines (
      artifact_id TEXT NOT NULL REFERENCES artifact_records(id) ON DELETE CASCADE,
      byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
      line_number INTEGER NOT NULL CHECK (line_number > 0),
      content TEXT NOT NULL,
      PRIMARY KEY (artifact_id, byte_offset)
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_text_lines_artifact_line
      ON artifact_text_lines (artifact_id, line_number, byte_offset);
  `);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isTextArtifact(record: Pick<ArtifactRecord, "mimeType">): boolean {
  const mime = record.mimeType?.toLocaleLowerCase();
  return mime !== undefined && (
    mime.startsWith("text/")
    || mime === "application/json"
    || mime.endsWith("+json")
    || mime === "application/xml"
    || mime.endsWith("+xml")
    || mime === "application/javascript"
    || mime === "application/sql"
  );
}

/**
 * SQLite metadata plus immutable filesystem bodies. Metadata reads never load
 * body bytes; only explicit reads and text-index rebuilds touch the filesystem.
 */
export class SqliteArtifactStore implements ArtifactStore {
  private readonly db: Database.Database;
  private readonly rootDirectory: string;
  private readonly deletingDirectory: string;
  private readonly maxStorageBytes?: number;

  constructor(options: SqliteArtifactStoreOptions) {
    this.db = openArtifactDatabase(options.databasePath);
    migrateArtifactStore(this.db);
    this.rootDirectory = resolve(options.storageDirectory);
    this.deletingDirectory = join(this.rootDirectory, ".deleting");
    if (options.maxStorageBytes !== undefined && (!Number.isInteger(options.maxStorageBytes) || options.maxStorageBytes < 0)) throw new Error("maxStorageBytes must be a non-negative integer");
    this.maxStorageBytes = options.maxStorageBytes === 0 ? undefined : options.maxStorageBytes;
  }

  async create(input: ArtifactCreateInput): Promise<ArtifactRecord> {
    const { content, ...createOptions } = input;
    const parsed = artifactCreateOptionsSchema.parse(createOptions);
    await this.ensureDirectories();

    const id = `artifact://${randomUUID()}` as ArtifactId;
    const storageLocation = `${id.slice("artifact://".length)}.blob`;
    const temporaryPath = join(this.rootDirectory, `.${randomUUID()}.tmp`);
    const finalPath = this.pathForLocation(storageLocation);
    let finalised = false;

    try {
      const body = await this.writeBody(temporaryPath, content);
      const now = new Date().toISOString();
      const record = artifactRecordSchema.parse({
        id,
        ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
        scope: parsed.scope,
        type: parsed.type,
        ...(parsed.mimeType === undefined ? {} : { mimeType: parsed.mimeType }),
        sizeBytes: body.sizeBytes,
        storageLocation,
        sha256: body.sha256,
        ...(parsed.summary === undefined ? {} : { summary: parsed.summary }),
        ...(parsed.displayName === undefined ? {} : { displayName: parsed.displayName }),
        metadata: parsed.metadata,
        createdAt: now,
        updatedAt: now,
        ...(parsed.expiresAt === undefined ? {} : { expiresAt: parsed.expiresAt }),
      });

      // Rename within one directory is atomic on the supported Node filesystems.
      await rename(temporaryPath, finalPath);
      finalised = true;
      try {
        this.insertRecord(record);
      } catch (error) {
        await rm(finalPath, { force: true });
        finalised = false;
        throw error;
      }

      if (isTextArtifact(record)) {
        try {
          await this.rebuildTextIndex(record.id);
        } catch (error) {
          // A caller must never receive a text Artifact with silently stale index state.
          await this.delete(record.id);
          throw error;
        }
      }
      return record;
    } finally {
      if (!finalised) await rm(temporaryPath, { force: true });
    }
  }

  async get(id: ArtifactId | string): Promise<ArtifactRecord | undefined> {
    return this.readRecord(this.parseId(id));
  }

  async read(id: ArtifactId | string, options: ArtifactReadOptions = {}): Promise<Uint8Array> {
    const artifactId = this.parseId(id);
    const record = this.requireRecord(artifactId);
    const parsed = artifactReadOptionsSchema.parse(options);
    const bodyPath = await this.requireBodyPath(record);
    const info = await stat(bodyPath);
    if (parsed.offset >= info.size) return new Uint8Array();
    const requestedLength = parsed.length ?? info.size - parsed.offset;
    const length = Math.min(requestedLength, info.size - parsed.offset);
    const body = Buffer.alloc(length);
    const file = await open(bodyPath, "r");
    try {
      let written = 0;
      while (written < length) {
        const { bytesRead } = await file.read(body, written, length - written, parsed.offset + written);
        if (bytesRead === 0) break;
        written += bytesRead;
      }
      const result = body.subarray(0, written);
      if (parsed.offset === 0 && parsed.length === undefined) this.assertChecksum(record, result);
      return result;
    } finally {
      await file.close();
    }
  }

  async delete(id: ArtifactId | string): Promise<boolean> {
    const artifactId = this.parseId(id);
    const record = this.readRecord(artifactId);
    if (record === undefined) return false;
    await this.ensureDirectories();

    const bodyPath = this.pathForLocation(record.storageLocation);
    const quarantinePath = join(this.deletingDirectory, `${artifactId.slice("artifact://".length)}.${randomUUID()}.blob`);
    let quarantined = false;
    try {
      await rename(bodyPath, quarantinePath);
      quarantined = true;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    try {
      this.db.transaction(() => {
        this.db.prepare("DELETE FROM artifact_text_lines WHERE artifact_id = ?").run(artifactId);
        this.db.prepare("DELETE FROM artifact_records WHERE id = ?").run(artifactId);
      })();
    } catch (error) {
      if (quarantined) await rename(quarantinePath, bodyPath);
      throw error;
    }

    // Metadata removal is already durable. A failed cleanup is a recoverable orphan.
    if (quarantined) await rm(quarantinePath, { force: true });
    return true;
  }

  async query(id: ArtifactId | string, options: ArtifactQueryOptions): Promise<readonly ArtifactQueryMatch[]> {
    const artifactId = this.parseId(id);
    const record = this.requireRecord(artifactId);
    if (!isTextArtifact(record)) throw new ArtifactQueryUnsupportedError(artifactId);
    await this.requireBodyPath(record);
    const parsed = artifactQueryOptionsSchema.parse(options);
    const rows = this.db.prepare(`
      SELECT byte_offset, line_number, content
      FROM artifact_text_lines
      WHERE artifact_id = ? AND INSTR(LOWER(content), LOWER(?)) > 0
      ORDER BY byte_offset ASC
      LIMIT ?
    `).all(artifactId, parsed.query, parsed.maxMatches * 3) as StoredTextLine[];

    const matches: ArtifactQueryMatch[] = [];
    const seenOffsets = new Set<number>();
    let returnedBytes = 0;
    for (const row of rows) {
      const queryOffset = row.content.toLocaleLowerCase().indexOf(parsed.query.toLocaleLowerCase());
      const snippet = this.snippet(row.content, Math.max(0, queryOffset), parsed.maxSnippetBytes);
      const snippetBytes = Buffer.byteLength(snippet);
      if (returnedBytes + snippetBytes > parsed.maxReturnedBytes) break;
      const byteOffset = row.byte_offset + Buffer.byteLength(row.content.slice(0, Math.max(0, queryOffset)));
      if (seenOffsets.has(byteOffset)) continue;
      seenOffsets.add(byteOffset);
      returnedBytes += snippetBytes;
      matches.push(artifactQueryMatchSchema.parse({
        artifactId,
        byteOffset,
        lineNumber: row.line_number,
        snippet,
      }));
      if (matches.length >= parsed.maxMatches) break;
    }
    return matches;
  }

  async rebuildTextIndex(id: ArtifactId | string): Promise<number> {
    const artifactId = this.parseId(id);
    const record = this.requireRecord(artifactId);
    if (!isTextArtifact(record)) throw new ArtifactQueryUnsupportedError(artifactId);
    const bodyPath = await this.requireBodyPath(record);
    await this.verify(artifactId);
    this.db.prepare("DELETE FROM artifact_text_lines WHERE artifact_id = ?").run(artifactId);

    const insert = this.db.prepare(`
      INSERT INTO artifact_text_lines (artifact_id, byte_offset, line_number, content) VALUES (?, ?, ?, ?)
    `);
    let count = 0;
    // The index is derived, but it must still change atomically: callers either
    // see the preceding complete index or the newly rebuilt complete index.
    this.db.exec("BEGIN");
    try {
      await this.forEachTextLine(bodyPath, async (line, lineNumber, byteOffset) => {
        for (const chunk of this.indexableChunks(line)) {
          insert.run(artifactId, byteOffset + chunk.byteOffset, lineNumber, chunk.content);
          count += 1;
        }
      });
      this.db.exec("COMMIT");
      return count;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async verify(id: ArtifactId | string): Promise<boolean> {
    const artifactId = this.parseId(id);
    const record = this.requireRecord(artifactId);
    const bodyPath = await this.requireBodyPath(record);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    for await (const chunk of createReadStream(bodyPath)) {
      hash.update(chunk);
      sizeBytes += chunk.length;
    }
    if (sizeBytes !== record.sizeBytes || hash.digest("hex") !== record.sha256) {
      throw new ArtifactIntegrityError(artifactId);
    }
    return true;
  }

  async cleanupExpired(now = new Date()): Promise<readonly ArtifactId[]> {
    const rows = this.db.prepare(`
      SELECT id FROM artifact_records WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at ASC, id ASC
    `).all(now.toISOString()) as Array<{ id: string }>;
    const deleted: ArtifactId[] = [];
    for (const row of rows) {
      const id = this.parseId(row.id);
      if (await this.delete(id)) deleted.push(id);
    }
    return deleted;
  }

  async recoverOrphans(): Promise<ArtifactRecoveryReport> {
    await this.ensureDirectories();
    const records = this.db.prepare("SELECT id, storage_location FROM artifact_records").all() as Array<Pick<StoredArtifact, "id" | "storage_location">>;
    const knownLocations = new Set(records.map((record) => record.storage_location));
    const missingBodyIds: ArtifactId[] = [];
    for (const record of records) {
      try {
        await stat(this.pathForLocation(record.storage_location));
      } catch (error) {
        if (isNotFound(error)) missingBodyIds.push(this.parseId(record.id));
        else throw error;
      }
    }

    const deletedOrphanLocations: string[] = [];
    for (const entry of await readdir(this.rootDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".blob") || knownLocations.has(entry.name)) continue;
      await rm(join(this.rootDirectory, entry.name));
      deletedOrphanLocations.push(entry.name);
    }
    // A completed metadata deletion may leave this quarantine behind only if its
    // final unlink was interrupted. It has no live record by construction.
    for (const entry of await readdir(this.deletingDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".blob")) continue;
      await rm(join(this.deletingDirectory, entry.name));
      deletedOrphanLocations.push(`.deleting/${entry.name}`);
    }
    return { deletedOrphanLocations, missingBodyIds };
  }

  close(): void {
    this.db.close();
  }

  private insertRecord(record: ArtifactRecord): void {
    if (this.maxStorageBytes !== undefined) {
      const statement = this.db.prepare(`
        INSERT INTO artifact_records (
          id, session_id, scope, type, mime_type, size_bytes, storage_location, sha256,
          summary, display_name, metadata, created_at, updated_at, expires_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE COALESCE((SELECT SUM(size_bytes) FROM artifact_records), 0) + ? <= ?
      `);
      const result = statement.run(
        record.id, record.sessionId ?? null, record.scope, record.type, record.mimeType ?? null, record.sizeBytes,
        record.storageLocation, record.sha256, record.summary ?? null, record.displayName ?? null, JSON.stringify(record.metadata),
        record.createdAt, record.updatedAt, record.expiresAt ?? null, record.sizeBytes, this.maxStorageBytes,
      );
      if (result.changes !== 1) throw new ArtifactQuotaExceededError(this.maxStorageBytes);
      return;
    }
    this.db.prepare(`
      INSERT INTO artifact_records (
        id, session_id, scope, type, mime_type, size_bytes, storage_location, sha256,
        summary, display_name, metadata, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.sessionId ?? null,
      record.scope,
      record.type,
      record.mimeType ?? null,
      record.sizeBytes,
      record.storageLocation,
      record.sha256,
      record.summary ?? null,
      record.displayName ?? null,
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
      record.expiresAt ?? null,
    );
  }

  private readRecord(id: ArtifactId): ArtifactRecord | undefined {
    const row = this.db.prepare("SELECT * FROM artifact_records WHERE id = ?").get(id) as StoredArtifact | undefined;
    if (row === undefined) return undefined;
    return artifactRecordSchema.parse({
      id: row.id,
      ...(row.session_id === null ? {} : { sessionId: row.session_id }),
      scope: row.scope,
      type: row.type,
      ...(row.mime_type === null ? {} : { mimeType: row.mime_type }),
      sizeBytes: row.size_bytes,
      storageLocation: row.storage_location,
      sha256: row.sha256,
      ...(row.summary === null ? {} : { summary: row.summary }),
      ...(row.display_name === null ? {} : { displayName: row.display_name }),
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    });
  }

  private requireRecord(id: ArtifactId): ArtifactRecord {
    const record = this.readRecord(id);
    if (record === undefined) throw new ArtifactNotFoundError(id);
    return record;
  }

  private parseId(id: string): ArtifactId {
    return artifactIdSchema.parse(id);
  }

  private async ensureDirectories(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true });
    await mkdir(this.deletingDirectory, { recursive: true });
  }

  private pathForLocation(storageLocation: string): string {
    const path = resolve(this.rootDirectory, storageLocation);
    const pathRelativeToRoot = relative(this.rootDirectory, path);
    if (pathRelativeToRoot === "" || pathRelativeToRoot.startsWith("..") || isAbsolute(pathRelativeToRoot)) {
      throw new Error("Artifact storage location escapes the configured storage directory");
    }
    return path;
  }

  private async requireBodyPath(record: ArtifactRecord): Promise<string> {
    const bodyPath = this.pathForLocation(record.storageLocation);
    try {
      await stat(bodyPath);
    } catch (error) {
      if (isNotFound(error)) throw new ArtifactBodyMissingError(record.id);
      throw error;
    }
    return bodyPath;
  }

  private async writeBody(path: string, content: ArtifactContent): Promise<{ sizeBytes: number; sha256: string }> {
    const file = await open(path, "wx");
    const hash = createHash("sha256");
    let sizeBytes = 0;
    try {
      for await (const chunk of this.asChunks(content)) {
        await this.writeAll(file, chunk);
        hash.update(chunk);
        sizeBytes += chunk.byteLength;
        if (!Number.isSafeInteger(sizeBytes)) throw new Error("Artifact body exceeds the maximum supported size");
      }
      await file.sync();
      return { sizeBytes, sha256: hash.digest("hex") };
    } finally {
      await file.close();
    }
  }

  private async *asChunks(content: ArtifactContent): AsyncIterable<Uint8Array> {
    if (typeof content === "string") {
      yield Buffer.from(content);
      return;
    }
    if (content instanceof Uint8Array) {
      yield content;
      return;
    }
    for await (const chunk of content) {
      if (!(chunk instanceof Uint8Array)) throw new TypeError("Artifact streams must yield Uint8Array chunks");
      yield chunk;
    }
  }

  private async writeAll(file: Awaited<ReturnType<typeof open>>, chunk: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await file.write(chunk.subarray(offset));
      if (bytesWritten === 0) throw new Error("Unable to write Artifact body");
      offset += bytesWritten;
    }
  }

  private assertChecksum(record: ArtifactRecord, body: Uint8Array): void {
    const checksum = createHash("sha256").update(body).digest("hex");
    if (checksum !== record.sha256) throw new ArtifactIntegrityError(record.id);
  }

  private async forEachTextLine(
    bodyPath: string,
    visit: (line: string, lineNumber: number, byteOffset: number) => Promise<void>,
  ): Promise<void> {
    const decoder = new TextDecoder();
    let pending = "";
    let lineNumber = 1;
    let byteOffset = 0;
    for await (const chunk of createReadStream(bodyPath)) {
      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const encodedLine = pending.slice(0, newline + 1);
        const line = encodedLine.slice(0, -1).replace(/\r$/, "");
        await visit(line, lineNumber, byteOffset);
        byteOffset += Buffer.byteLength(encodedLine);
        lineNumber += 1;
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    }
    pending += decoder.decode();
    if (pending.length > 0) await visit(pending.replace(/\r$/, ""), lineNumber, byteOffset);
  }

  /** Index chunks cap one SQLite row, even for a multi-megabyte single line. */
  private indexableChunks(line: string): Array<{ byteOffset: number; content: string }> {
    const maximumBytes = 8_192;
    const overlapBytes = 4_096;
    const chunks: Array<{ byteOffset: number; content: string }> = [];
    let content = "";
    let contentBytes = 0;
    let byteOffset = 0;
    for (const character of line) {
      const characterBytes = Buffer.byteLength(character);
      if (contentBytes > 0 && contentBytes + characterBytes > maximumBytes) {
        chunks.push({ byteOffset, content });
        const overlap = this.limitUtf8FromEnd(content, overlapBytes);
        const overlapSize = Buffer.byteLength(overlap);
        byteOffset += contentBytes - overlapSize;
        content = overlap;
        contentBytes = overlapSize;
      }
      content += character;
      contentBytes += characterBytes;
    }
    if (content.length > 0) chunks.push({ byteOffset, content });
    return chunks;
  }

  private snippet(content: string, matchOffset: number, maximumBytes: number): string {
    const before = content.slice(0, matchOffset);
    const after = content.slice(matchOffset);
    const prefix = this.limitUtf8FromEnd(before, Math.floor(maximumBytes / 3));
    const remaining = Math.max(0, maximumBytes - Buffer.byteLength(prefix));
    return `${prefix}${this.limitUtf8(after, remaining)}`;
  }

  private limitUtf8(value: string, maximumBytes: number): string {
    let result = "";
    let used = 0;
    for (const character of value) {
      const size = Buffer.byteLength(character);
      if (used + size > maximumBytes) break;
      result += character;
      used += size;
    }
    return result;
  }

  private limitUtf8FromEnd(value: string, maximumBytes: number): string {
    const result: string[] = [];
    let used = 0;
    for (const character of [...value].reverse()) {
      const size = Buffer.byteLength(character);
      if (used + size > maximumBytes) break;
      result.push(character);
      used += size;
    }
    return result.reverse().join("");
  }
}
