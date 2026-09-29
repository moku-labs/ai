/**
 * @file journal driver seam — structural SQLite driver contract.
 */
import type { ItemStatus, RunStatus } from "../types";

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

/** Raw `items` row shape, matching the SQL schema column-for-column. */
export type ItemDatabaseRow = {
  id: string;
  run_id: string;
  build_file: string;
  planning_key: string;
  task: string;
  provider: string;
  pack_version: string | null;
  artifact_key: string | null;
  content_hash: string | null;
  status: ItemStatus;
  estimated_cost_usd: number;
  actual_cost_usd: number | null;
  attempt_count: number;
  updated_at: number;
  label: string | null;
  build_name: string | null;
  mime_type: string | null;
};

/** Raw `runs` row shape, matching the SQL schema column-for-column. */
export type RunDatabaseRow = {
  id: string;
  created_at: number;
  status: RunStatus;
  glob: string;
  max_cost_usd: number | null;
  finished_at: number | null;
};
