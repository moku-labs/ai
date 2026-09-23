/**
 * @file journal schema — DDL for runs/items/attempts (metadata only, no payload columns).
 */
import type { SqliteDriver } from "./driver/types";

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    glob TEXT NOT NULL,
    max_cost_usd REAL,
    finished_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    build_file TEXT NOT NULL,
    planning_key TEXT NOT NULL,
    task TEXT NOT NULL,
    provider TEXT NOT NULL,
    pack_version TEXT,
    artifact_key TEXT,
    content_hash TEXT,
    status TEXT NOT NULL,
    estimated_cost_usd REAL NOT NULL,
    actual_cost_usd REAL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    label TEXT,
    build_name TEXT,
    mime_type TEXT,
    UNIQUE (run_id, planning_key)
  );
  CREATE INDEX IF NOT EXISTS idx_items_run_status ON items(run_id, status);
  CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL REFERENCES items(id),
    provider TEXT NOT NULL,
    account TEXT NOT NULL DEFAULT 'default',
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    outcome TEXT,
    error_class TEXT,
    cost_usd REAL,
    external_id TEXT,
    job_state TEXT
  );
`;

/** Index DDL that references migrated columns, so it runs after {@link migrateSchema}. */
const INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_items_artifact ON items(artifact_key, status);
  CREATE INDEX IF NOT EXISTS idx_attempts_item ON attempts(item_id);
`;

/** Columns added after the first release, per table, with their SQL type. */
const ADDED_COLUMNS: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  items: [
    ["label", "TEXT"],
    ["build_name", "TEXT"],
    ["mime_type", "TEXT"]
  ],
  attempts: [
    ["external_id", "TEXT"],
    ["job_state", "TEXT"]
  ]
};

/**
 * Adds every column from {@link ADDED_COLUMNS} that an older journal file is
 * missing. Reads `PRAGMA table_info` per table, so running it twice is a no-op.
 *
 * @param driver - Open SQLite driver.
 * @example
 * ```ts
 * migrateSchema(driver);
 * ```
 */
export function migrateSchema(driver: SqliteDriver): void {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const existing = new Set(
      driver.all<{ name: string }>(`PRAGMA table_info(${table})`).map(row => row.name)
    );
    for (const [column, type] of columns) {
      if (existing.has(column)) continue;
      driver.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}

/**
 * Creates the journal schema idempotently (CREATE TABLE/INDEX IF NOT EXISTS).
 * Metadata only — status, attempts, costs, hashes, timestamps, provenance.
 * Never a free-form payload column, by construction.
 *
 * @param driver - Open SQLite driver.
 * @example
 * ```ts
 * createSchema(driver);
 * ```
 */
export function createSchema(driver: SqliteDriver): void {
  driver.exec(SCHEMA_SQL);
  migrateSchema(driver);
  driver.exec(INDEX_SQL);
}
