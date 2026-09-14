import Database from "better-sqlite3";

export interface SqliteMigration { version: number; name: string; up(db: Database.Database): void; }
export interface SqliteMigrationRunnerOptions { beforeMigration?: (db: Database.Database, fromVersion: number, toVersion: number) => void; }

export class SqliteMigrationError extends Error { readonly code = "migration_failed"; }

/** Monotonic, transactional migration runner shared by operational tooling. */
export class SqliteMigrationRunner {
  private readonly db: Database.Database;
  constructor(filename: string, private readonly options: SqliteMigrationRunnerOptions = {}) {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec("CREATE TABLE IF NOT EXISTS mnemos_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  }
  currentVersion(): number { return Number((this.db.prepare("SELECT COALESCE(MAX(version),0) AS version FROM mnemos_schema_migrations").get() as { version: number }).version); }
  run(migrations: readonly SqliteMigration[]): number {
    const ordered = [...migrations].sort((left, right) => left.version - right.version);
    if (ordered.some((migration, index) => migration.version < 1 || (index > 0 && migration.version === ordered[index - 1]!.version))) throw new Error("Migration versions must be unique positive integers");
    const current = this.currentVersion();
    for (const migration of ordered) {
      if (migration.version <= current) continue;
      if (migration.version !== this.currentVersion() + 1) throw new SqliteMigrationError(`Migration ${migration.version} is not the next version`);
      try {
        const fromVersion = this.currentVersion();
        this.options.beforeMigration?.(this.db, fromVersion, migration.version);
        // IMMEDIATE takes the SQLite write lock before running migration code, so
        // concurrent startup processes cannot both observe the same version.
        this.db.transaction(() => {
          migration.up(this.db);
          this.db.prepare("INSERT INTO mnemos_schema_migrations (version,name,applied_at) VALUES (?,?,?)").run(migration.version, migration.name, new Date().toISOString());
        }).immediate();
      } catch (error) {
        throw new SqliteMigrationError(`Migration ${migration.version} (${migration.name}) failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
    return this.currentVersion();
  }
  list(): readonly { version: number; name: string; appliedAt: string }[] { return (this.db.prepare("SELECT version,name,applied_at FROM mnemos_schema_migrations ORDER BY version").all() as Array<{ version: number; name: string; applied_at: string }>).map((row) => ({ version: row.version, name: row.name, appliedAt: row.applied_at })); }
  close(): void { this.db.close(); }
}
