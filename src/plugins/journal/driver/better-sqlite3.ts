/**
 * @file better-sqlite3 (Node) driver implementation skeleton.
 */
import type { DriverOpenOptions, SqliteDriver } from "./types";

/**
 * Opens a better-sqlite3-backed driver.
 *
 * @param _options - Database path + busy timeout.
 * @example
 * ```ts
 * const driver = openBetterSqlite3Driver(options);
 * ```
 */
export function openBetterSqlite3Driver(_options: DriverOpenOptions): SqliteDriver {
  throw new Error("not implemented");
}
