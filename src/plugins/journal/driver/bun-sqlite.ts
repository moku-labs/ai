/**
 * @file bun:sqlite (Bun) driver implementation skeleton.
 */
import type { DriverOpenOptions, SqliteDriver } from "./types";

/**
 * Opens a bun:sqlite-backed driver.
 *
 * @param _options - Database path + busy timeout.
 * @example
 * ```ts
 * const driver = openBunSqliteDriver(options);
 * ```
 */
export function openBunSqliteDriver(_options: DriverOpenOptions): SqliteDriver {
  throw new Error("not implemented");
}
