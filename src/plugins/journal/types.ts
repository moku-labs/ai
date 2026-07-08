/**
 * @file journal core plugin — type definitions.
 */
import type { SqliteDriver } from "./driver/types";

/**
 *
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
 *
 */
export type State = {
  /** Open driver connection; null until onStart. */
  driver: SqliteDriver | null;
  /** Writer-side checkpoint timer; null when not running. */
  checkpointTimer: ReturnType<typeof setInterval> | null;
};

/**
 *
 */
export type RunStatus = "active" | "done" | "failed" | "paused" | "budget-stopped";
/**
 *
 */
export type ItemStatus = "queued" | "dispatching" | "done" | "failed" | "flagged";
/**
 *
 */
export type ErrorClass =
  | "http-5xx"
  | "http-429"
  | "timeout"
  | "network"
  | "http-4xx"
  | "content-policy";
/**
 *
 */
export type AttemptOutcome = "done" | "retryable-error" | "terminal-error" | "flagged";

/**
 *
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
 *
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
 *
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
 *
 */
export type GateResult = { ok: true } | { ok: false; reason: "budget" | "duplicate" };

/**
 *
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
 *
 */
export type AttemptStart = { provider: string; account: string; startedAt: number };
/**
 *
 */
export type AttemptEnd = {
  endedAt: number;
  outcome: AttemptOutcome;
  errorClass?: ErrorClass;
  costUsd?: number;
};
/**
 *
 */
export type RunSnapshot = { run: RunRow; totals: RunTotals; recentItems: ItemRow[] };
/**
 *
 */
export type ItemFilter = { status?: ItemStatus; limit?: number; afterUpdatedAt?: number };

/**
 *
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
