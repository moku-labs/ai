/**
 * @file journal driver selection — bun:sqlite on Bun, better-sqlite3 on Node.
 */
import { openBetterSqlite3Driver } from "./better-sqlite3";
import { openBunSqliteDriver } from "./bun-sqlite";
import type { DriverOpenOptions, SqliteDriver } from "./types";

/**
 * Opens the runtime-appropriate SQLite driver and applies the durability
 * pragma set (busy_timeout, WAL, synchronous=FULL, fullfsync=1). The busy
 * timeout is set first: switching a new database to WAL takes a lock, so a
 * parallel first start must wait for it instead of throwing "database is
 * locked".
 *
 * @param options - Database path + busy timeout.
 * @returns An open, pragma-configured SqliteDriver.
 * @example
 * ```ts
 * const driver = openSqliteDriver({ path: ".moku/journal.db", busyTimeoutMs: 5_000 });
 * ```
 */
export function openSqliteDriver(options: DriverOpenOptions): SqliteDriver {
  const driver =
    typeof Bun === "undefined" ? openBetterSqlite3Driver(options) : openBunSqliteDriver(options);

  driver.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs}`);
  driver.exec("PRAGMA journal_mode = WAL");
  driver.exec("PRAGMA synchronous = FULL");
  driver.exec("PRAGMA fullfsync = 1");

  return driver;
}
