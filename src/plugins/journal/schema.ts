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
    cost_usd REAL
  );
`;

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
}
