/**
 * @file journal driver seam — structural SQLite driver contract.
 */

/** Minimal structural SQLite driver surface both backends implement. */
export type SqliteDriver = {
  /** Execute DDL/PRAGMA statements. */
  exec(sql: string): void;
  /** Run a write statement; returns changed-row count. */
  run(sql: string, params?: readonly unknown[]): { changes: number };
  /** Fetch all rows. */
  all<T>(sql: string, params?: readonly unknown[]): T[];
  /** Fetch one row or undefined. */
  get<T>(sql: string, params?: readonly unknown[]): T | undefined;
  /** Run fn inside BEGIN IMMEDIATE … COMMIT/ROLLBACK. */
  transactionImmediate<T>(fn: () => T): T;
  /** Close the connection. */
  close(): void;
};

/** Options for opening a driver. */
export type DriverOpenOptions = {
  path: string;
  busyTimeoutMs: number;
};
