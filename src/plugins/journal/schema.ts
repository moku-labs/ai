/**
 * @file journal schema — DDL for runs/items/attempts (metadata only, no payload columns).
 */
import type { SqliteDriver } from "./driver/types";

/**
 * Creates the journal schema idempotently (CREATE TABLE IF NOT EXISTS …).
 *
 * @param _driver - Open SQLite driver.
 * @example
 * ```ts
 * createSchema(driver);
 * ```
 */
export function createSchema(_driver: SqliteDriver): void {
  throw new Error("not implemented");
}
