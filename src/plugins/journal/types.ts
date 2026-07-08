/**
 * @file journal core plugin — type definitions.
 */
import type { SqliteDriver } from "./driver/types";

/**
 * Journal core plugin configuration: durable file path, checkpoint cadence,
 * and SQLite busy-timeout tuning.
 */
export type Config = {
  /** Path to the journal database file. */
  path: string;
  /** Interval between writer-side wal_checkpoint(TRUNCATE) calls, ms. */
  checkpointIntervalMs: number;
  /** SQLite busy_timeout, ms. */
  busyTimeoutMs: number;
};

/**
 * Journal core plugin mutable state: the open driver connection and the
 * writer-side checkpoint timer handle, both null until `onStart`.
 */
export type State = {
  /** Open driver connection; null until onStart. */
  driver: SqliteDriver | null;
  /** Writer-side checkpoint timer; null when not running. */
  checkpointTimer: ReturnType<typeof setInterval> | null;
};

/**
 * Lifecycle status of a `runs` row — one row per invocation.
 */
export type RunStatus = "active" | "done" | "failed" | "paused" | "budget-stopped";
/**
 * State-machine status of an `items` row: `queued → dispatching → done | failed | flagged`.
 */
export type ItemStatus = "queued" | "dispatching" | "done" | "failed" | "flagged";
/**
 * Classification of a failed provider attempt, recorded on the `attempts` row.
 */
export type ErrorClass =
  | "http-5xx"
  | "http-429"
  | "timeout"
  | "network"
  | "http-4xx"
  | "content-policy";
/**
 * Terminal outcome of a single provider attempt.
 */
export type AttemptOutcome = "done" | "retryable-error" | "terminal-error" | "flagged";

/**
 * One `runs` row — the single durable record for an invocation.
 */
export type RunRow = {
  id: string;
  createdAt: number;
  status: RunStatus;
  glob: string;
  maxCostUsd: number | null;
  finishedAt: number | null;
};

/**
 * Planning-time intent for one item, as submitted to `insertItems`.
 */
export type ItemIntent = {
  planningKey: string;
  buildFile: string;
  task: string;
  provider: string;
  packVersion: string | null;
  estimatedCostUsd: number;
};

/**
 * One `items` row — an `ItemIntent` plus durable state-machine and identity fields.
 */
export type ItemRow = ItemIntent & {
  id: string;
  runId: string;
  status: ItemStatus;
  artifactKey: string | null;
  contentHash: string | null;
  actualCostUsd: number | null;
  attemptCount: number;
  updatedAt: number;
};

/**
 * Result of `gateToDispatching` — a discriminated union that narrows on `ok`.
 */
export type GateResult = { ok: true } | { ok: false; reason: "budget" | "duplicate" };

/**
 * Aggregate item counts and spend for one run, used for progress events,
 * budget math, and `moku status`.
 */
export type RunTotals = {
  total: number;
  queued: number;
  dispatching: number;
  done: number;
  failed: number;
  flagged: number;
  spendUsd: number;
  estimatedRemainingUsd: number;
};

/**
 * Fields recorded when a provider attempt begins, passed to `recordAttempt`.
 */
export type AttemptStart = { provider: string; account: string; startedAt: number };
/**
 * Fields recorded when a provider attempt ends, passed to `finishAttempt`.
 */
export type AttemptEnd = {
  endedAt: number;
  outcome: AttemptOutcome;
  errorClass?: ErrorClass;
  costUsd?: number;
};
/**
 * Point-in-time read of a run: the run row, its aggregate totals, and its
 * most recently updated items. Returned by `readSnapshot`.
 */
export type RunSnapshot = { run: RunRow; totals: RunTotals; recentItems: ItemRow[] };
/**
 * Optional filter for `listItems`: narrow by status, cap the row count, or
 * page by `updated_at`.
 */
export type ItemFilter = { status?: ItemStatus; limit?: number; afterUpdatedAt?: number };

/**
 * The journal's public API surface, injected as `ctx.journal` on every
 * regular plugin's context.
 */
export type JournalApi = {
  openRun(opts: { glob: string; maxCostUsd?: number }): RunRow;
  getRun(runId: string): RunRow | undefined;
  latestResumableRun(): RunRow | undefined;
  insertItems(runId: string, items: ItemIntent[]): ItemRow[];
  requeueDispatching(runId: string): number;
  gateToDispatching(itemId: string): GateResult;
  recordAttempt(itemId: string, attempt: AttemptStart): number;
  finishAttempt(attemptId: number, end: AttemptEnd): void;
  commitDone(
    itemId: string,
    result: { actualCostUsd: number; artifactKey: string; contentHash: string }
  ): void;
  markFailed(itemId: string, result: { errorClass: ErrorClass; terminal: boolean }): void;
  markFlagged(itemId: string): void;
  setRunStatus(runId: string, status: RunStatus): void;
  totals(runId: string): RunTotals;
  listItems(runId: string, filter?: ItemFilter): ItemRow[];
  readSnapshot(runId: string): RunSnapshot;
  checkpoint(): void;
};
