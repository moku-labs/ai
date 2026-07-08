/**
 * @file journal driver selection — bun:sqlite on Bun, better-sqlite3 on Node.
 */
import type { DriverOpenOptions, SqliteDriver } from "./types";

/**
 * Opens the runtime-appropriate SQLite driver and applies the durability
 * pragma set (WAL, synchronous=FULL, fullfsync=1, busy_timeout).
 *
 * @param _options - Database path + busy timeout.
 * @example
 * ```ts
 * const driver = openSqliteDriver({ path: ".moku/journal.db", busyTimeoutMs: 5_000 });
 * ```
 */
export function openSqliteDriver(_options: DriverOpenOptions): SqliteDriver {
  throw new Error("not implemented");
}
