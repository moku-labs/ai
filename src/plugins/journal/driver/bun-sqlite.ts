/**
 * @file bun:sqlite (Bun) driver implementation.
 */
import type { SQLQueryBindings } from "bun:sqlite";
import { createRequire } from "node:module";
import type { DriverOpenOptions, SqliteDriver } from "./types";

const requireBunModule = createRequire(import.meta.url);

/** The `bun:sqlite` module's `Database` class, loaded lazily (see `openBunSqliteDriver`). */
type BunDatabase = InstanceType<typeof import("bun:sqlite").Database>;

/**
 * Narrows the driver seam's structural `readonly unknown[]` bind parameters
 * to bun:sqlite's own `SQLQueryBindings[]` at the adapter boundary. The
 * `SqliteDriver` interface stays intentionally untyped-by-vendor (structural,
 * per the driver-seam rule); this single audited cast is where that
 * structural type meets bun:sqlite's concrete binding type.
 *
 * @param params - Bound statement parameters, as accepted by SqliteDriver.
 * @returns The same values, typed as bun:sqlite bind parameters.
 * @example
 * ```ts
 * db.prepare(sql).run(...toBunBindings(params));
 * ```
 */
function toBunBindings(params: readonly unknown[]): SQLQueryBindings[] {
  return params as SQLQueryBindings[];
}

/**
 * Executes DDL/PRAGMA statements against a bun:sqlite connection.
 *
 * @param db - Open bun:sqlite connection.
 * @param sql - SQL text to execute.
 * @example
 * ```ts
 * execSql(db, "PRAGMA journal_mode = WAL");
 * ```
 */
function execSql(db: BunDatabase, sql: string): void {
  db.exec(sql);
}

/**
 * Runs a write statement against a bun:sqlite connection.
 *
 * @param db - Open bun:sqlite connection.
 * @param sql - SQL text to run.
 * @param params - Bound statement parameters.
 * @returns The number of changed rows.
 * @example
 * ```ts
 * const { changes } = runSql(db, "UPDATE items SET status = ? WHERE id = ?", ["done", id]);
 * ```
 */
function runSql(db: BunDatabase, sql: string, params: readonly unknown[]): { changes: number } {
  const result = db.prepare(sql).run(...toBunBindings(params));
  return { changes: result.changes };
}

/**
 * Fetches all rows for a query against a bun:sqlite connection.
 *
 * @param db - Open bun:sqlite connection.
 * @param sql - SQL text to run.
 * @param params - Bound statement parameters.
 * @returns All matching rows.
 * @example
 * ```ts
 * const rows = allSql<ItemRow>(db, "SELECT * FROM items WHERE run_id = ?", [runId]);
 * ```
 */
function allSql<T>(db: BunDatabase, sql: string, params: readonly unknown[]): T[] {
  return db.prepare(sql).all(...toBunBindings(params)) as T[];
}

/**
 * Fetches one row for a query against a bun:sqlite connection.
 *
 * @param db - Open bun:sqlite connection.
 * @param sql - SQL text to run.
 * @param params - Bound statement parameters.
 * @returns The first matching row, or undefined.
 * @example
 * ```ts
 * const row = getSql<RunRow>(db, "SELECT * FROM runs WHERE id = ?", [runId]);
 * ```
 */
function getSql<T>(db: BunDatabase, sql: string, params: readonly unknown[]): T | undefined {
  return db.prepare(sql).get(...toBunBindings(params)) as T | undefined;
}

/**
 * Runs `fn` inside a `BEGIN IMMEDIATE … COMMIT`/`ROLLBACK` transaction.
 *
 * @param db - Open bun:sqlite connection.
 * @param fn - Work to run inside the transaction.
 * @returns `fn`'s return value.
 * @example
 * ```ts
 * const result = transactionImmediateSql(db, () => db.prepare("...").run());
 * ```
 */
function transactionImmediateSql<T>(db: BunDatabase, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Opens a bun:sqlite-backed driver. `bun:sqlite` is loaded lazily via
 * `require`, guarded so this module never statically resolves the Bun-only
 * built-in under Node — the call only executes once the runtime detection
 * in `select.ts` has already confirmed Bun.
 *
 * @param options - Database path + busy timeout.
 * @returns A structural SqliteDriver backed by bun:sqlite.
 * @example
 * ```ts
 * const driver = openBunSqliteDriver({ path: ".moku/journal.db", busyTimeoutMs: 5_000 });
 * ```
 */
export function openBunSqliteDriver(options: DriverOpenOptions): SqliteDriver {
  const { Database } = requireBunModule("bun:sqlite") as typeof import("bun:sqlite");
  const db: BunDatabase = new Database(options.path);

  /**
   * Executes DDL/PRAGMA statements, bound to this connection.
   *
   * @param sql - SQL text to execute.
   * @example
   * ```ts
   * driver.exec("PRAGMA journal_mode = WAL");
   * ```
   */
  const boundExec = (sql: string): void => {
    execSql(db, sql);
  };

  /**
   * Runs a write statement, bound to this connection.
   *
   * @param sql - SQL text to run.
   * @param params - Bound statement parameters.
   * @returns The number of changed rows.
   * @example
   * ```ts
   * driver.run("UPDATE items SET status = ? WHERE id = ?", ["done", id]);
   * ```
   */
  const boundRun = (sql: string, params: readonly unknown[] = []): { changes: number } =>
    runSql(db, sql, params);

  /**
   * Fetches all rows, bound to this connection.
   *
   * @param sql - SQL text to run.
   * @param params - Bound statement parameters.
   * @returns All matching rows.
   * @example
   * ```ts
   * driver.all("SELECT * FROM items WHERE run_id = ?", [runId]);
   * ```
   */
  const boundAll = <T>(sql: string, params: readonly unknown[] = []): T[] =>
    allSql<T>(db, sql, params);

  /**
   * Fetches one row, bound to this connection.
   *
   * @param sql - SQL text to run.
   * @param params - Bound statement parameters.
   * @returns The first matching row, or undefined.
   * @example
   * ```ts
   * driver.get("SELECT * FROM runs WHERE id = ?", [runId]);
   * ```
   */
  const boundGet = <T>(sql: string, params: readonly unknown[] = []): T | undefined =>
    getSql<T>(db, sql, params);

  /**
   * Runs `fn` inside `BEGIN IMMEDIATE … COMMIT`/`ROLLBACK`, bound to this connection.
   *
   * @param fn - Work to run inside the transaction.
   * @returns `fn`'s return value.
   * @example
   * ```ts
   * driver.transactionImmediate(() => driver.run("..."));
   * ```
   */
  const boundTransactionImmediate = <T>(fn: () => T): T => transactionImmediateSql(db, fn);

  /**
   * Closes the connection.
   *
   * @example
   * ```ts
   * driver.close();
   * ```
   */
  const boundClose = (): void => {
    db.close();
  };

  return {
    exec: boundExec,
    run: boundRun,
    all: boundAll,
    get: boundGet,
    transactionImmediate: boundTransactionImmediate,
    close: boundClose
  };
}
