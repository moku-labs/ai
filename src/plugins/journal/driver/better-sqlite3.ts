/**
 * @file better-sqlite3 (Node) driver implementation.
 */
import Database from "better-sqlite3";
import type { DriverOpenOptions, SqliteDriver } from "./types";

/**
 * Executes DDL/PRAGMA statements against a better-sqlite3 connection.
 *
 * @param db - Open better-sqlite3 connection.
 * @param sql - SQL text to execute.
 * @example
 * ```ts
 * execSql(db, "PRAGMA journal_mode = WAL");
 * ```
 */
function execSql(db: Database.Database, sql: string): void {
  db.exec(sql);
}

/**
 * Runs a write statement against a better-sqlite3 connection.
 *
 * @param db - Open better-sqlite3 connection.
 * @param sql - SQL text to run.
 * @param params - Bound statement parameters.
 * @returns The number of changed rows.
 * @example
 * ```ts
 * const { changes } = runSql(db, "UPDATE items SET status = ? WHERE id = ?", ["done", id]);
 * ```
 */
function runSql(
  db: Database.Database,
  sql: string,
  params: readonly unknown[]
): { changes: number } {
  const result = db.prepare(sql).run(...params);
  return { changes: result.changes };
}

/**
 * Fetches all rows for a query against a better-sqlite3 connection.
 *
 * @param db - Open better-sqlite3 connection.
 * @param sql - SQL text to run.
 * @param params - Bound statement parameters.
 * @returns All matching rows.
 * @example
 * ```ts
 * const rows = allSql<ItemRow>(db, "SELECT * FROM items WHERE run_id = ?", [runId]);
 * ```
 */
function allSql<T>(db: Database.Database, sql: string, params: readonly unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

/**
 * Fetches one row for a query against a better-sqlite3 connection.
 *
 * @param db - Open better-sqlite3 connection.
 * @param sql - SQL text to run.
 * @param params - Bound statement parameters.
 * @returns The first matching row, or undefined.
 * @example
 * ```ts
 * const row = getSql<RunRow>(db, "SELECT * FROM runs WHERE id = ?", [runId]);
 * ```
 */
function getSql<T>(db: Database.Database, sql: string, params: readonly unknown[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

/**
 * Runs `fn` inside a `BEGIN IMMEDIATE … COMMIT`/`ROLLBACK` transaction.
 *
 * @param db - Open better-sqlite3 connection.
 * @param fn - Work to run inside the transaction.
 * @returns `fn`'s return value.
 * @example
 * ```ts
 * const result = transactionImmediateSql(db, () => db.prepare("...").run());
 * ```
 */
function transactionImmediateSql<T>(db: Database.Database, fn: () => T): T {
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
 * Opens a better-sqlite3-backed driver. `better-sqlite3` ships prebuilt
 * binaries and is only ever imported when the runtime detection in
 * `select.ts` has already confirmed Node (no Bun global).
 *
 * @param options - Database path + busy timeout.
 * @returns A structural SqliteDriver backed by better-sqlite3.
 * @example
 * ```ts
 * const driver = openBetterSqlite3Driver({ path: ".moku/journal.db", busyTimeoutMs: 5_000 });
 * ```
 */
export function openBetterSqlite3Driver(options: DriverOpenOptions): SqliteDriver {
  const db = new Database(options.path);

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
