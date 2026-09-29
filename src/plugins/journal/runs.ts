/**
 * @file journal core plugin — `runs` rows: open, look up, resume, status and totals.
 */
import { mapRun, requireDriver, SQL_NULL } from "./db";
import type { RunDatabaseRow, SqliteDriver } from "./driver/types";
import type { RunRow, RunStatus, RunTotals, State } from "./types";

/**
 * Reads one run row on an arbitrary driver connection.
 *
 * @param driver - Any open SqliteDriver (primary or short-lived).
 * @param runId - Run id to look up.
 * @returns The run row, or undefined if not found.
 */
export function readRun(driver: SqliteDriver, runId: string): RunRow | undefined {
  const row = driver.get<RunDatabaseRow>("SELECT * FROM runs WHERE id = ?", [runId]);
  return row ? mapRun(row) : undefined;
}

/**
 * Computes run totals on an arbitrary driver connection.
 *
 * @param driver - Any open SqliteDriver (primary or short-lived).
 * @param runId - Run id to aggregate.
 * @returns Aggregate counts and spend for the run.
 */
export function readTotals(driver: SqliteDriver, runId: string): RunTotals {
  const row = driver.get<{
    total: number;
    queued: number;
    dispatching: number;
    done: number;
    failed: number;
    flagged: number;
    spend_usd: number;
    estimated_remaining_usd: number;
  }>(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
       COALESCE(SUM(CASE WHEN status = 'dispatching' THEN 1 ELSE 0 END), 0) AS dispatching,
       COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done,
       COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
       COALESCE(SUM(CASE WHEN status = 'flagged' THEN 1 ELSE 0 END), 0) AS flagged,
       COALESCE(SUM(CASE WHEN status = 'done' THEN actual_cost_usd ELSE 0 END), 0) AS spend_usd,
       COALESCE(SUM(CASE WHEN status IN ('queued', 'dispatching') THEN estimated_cost_usd ELSE 0 END), 0) AS estimated_remaining_usd
     FROM items WHERE run_id = ?`,
    [runId]
  );

  return {
    total: row?.total ?? 0,
    queued: row?.queued ?? 0,
    dispatching: row?.dispatching ?? 0,
    done: row?.done ?? 0,
    failed: row?.failed ?? 0,
    flagged: row?.flagged ?? 0,
    spendUsd: row?.spend_usd ?? 0,
    estimatedRemainingUsd: row?.estimated_remaining_usd ?? 0
  };
}

/**
 * Creates the single `runs` row for one invocation.
 *
 * @param state - Journal plugin state.
 * @param opts - The invocation's file glob and optional budget cap.
 * @param opts.glob - The invocation's file pattern.
 * @param opts.maxCostUsd - Optional budget cap; omit for no cap.
 * @returns The newly created run row (status `active`).
 */
export function openRun(state: State, opts: { glob: string; maxCostUsd?: number }): RunRow {
  const driver = requireDriver(state);
  return driver.transactionImmediate<RunRow>(() => {
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const maxCostUsd = opts.maxCostUsd ?? SQL_NULL;
    driver.run(
      "INSERT INTO runs (id, created_at, status, glob, max_cost_usd, finished_at) VALUES (?, ?, 'active', ?, ?, ?)",
      [id, createdAt, opts.glob, maxCostUsd, SQL_NULL]
    );
    return {
      id,
      createdAt,
      status: "active",
      glob: opts.glob,
      maxCostUsd,
      finishedAt: SQL_NULL
    };
  });
}

/**
 * Looks up one run by id.
 *
 * @param state - Journal plugin state.
 * @param runId - Run id to look up.
 * @returns The run row, or undefined if not found.
 */
export function getRun(state: State, runId: string): RunRow | undefined {
  const driver = requireDriver(state);
  return readRun(driver, runId);
}

/**
 * Finds the most recently created run still eligible for `resume`
 * (status `active`, `paused`, or `budget-stopped`), skipping excluded ids.
 *
 * @param state - Journal plugin state.
 * @param opts - Optional filter.
 * @param opts.exclude - Run ids to skip; omitted or empty skips none.
 * @returns The latest resumable run, or undefined if none exists.
 */
export function latestResumableRun(
  state: State,
  opts: { exclude?: readonly string[] } = {}
): RunRow | undefined {
  const driver = requireDriver(state);
  const exclude = opts.exclude ?? [];
  const placeholders = exclude.map(() => "?").join(", ");
  const excludeClause = exclude.length > 0 ? ` AND id NOT IN (${placeholders})` : "";

  const row = driver.get<RunDatabaseRow>(
    `SELECT * FROM runs WHERE status IN ('active', 'paused', 'budget-stopped')${excludeClause} ORDER BY created_at DESC LIMIT 1`,
    exclude
  );
  return row ? mapRun(row) : undefined;
}

/**
 * Finds the newest run of any status.
 *
 * @param state - Journal plugin state.
 * @returns The newest run, or undefined when the journal is empty.
 */
export function latestRun(state: State): RunRow | undefined {
  const driver = requireDriver(state);
  const row = driver.get<RunDatabaseRow>(
    "SELECT * FROM runs ORDER BY created_at DESC, rowid DESC LIMIT 1"
  );
  return row ? mapRun(row) : undefined;
}

/**
 * Sets a run's status, recording `finished_at` when the new status is
 * terminal (`done` or `failed`).
 *
 * @param state - Journal plugin state.
 * @param runId - Run id to update.
 * @param status - The new run status.
 */
export function setRunStatus(state: State, runId: string, status: RunStatus): void {
  const driver = requireDriver(state);
  driver.transactionImmediate<void>(() => {
    const isFinal = status === "done" || status === "failed";
    driver.run(
      "UPDATE runs SET status = ?, finished_at = CASE WHEN ? THEN ? ELSE finished_at END WHERE id = ?",
      [status, isFinal ? 1 : 0, Date.now(), runId]
    );
  });
}

/**
 * Computes aggregate item counts and spend for a run.
 *
 * @param state - Journal plugin state.
 * @param runId - Run id to aggregate.
 * @returns Aggregate counts and spend for the run.
 */
export function totalsOf(state: State, runId: string): RunTotals {
  const driver = requireDriver(state);
  return readTotals(driver, runId);
}
