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
  | "content-policy"
  | "unknown";
/**
 * Terminal outcome of a single provider attempt.
 */
export type AttemptOutcome = "done" | "retryable-error" | "terminal-error" | "flagged" | "aborted";

/**
 * Lifecycle of a provider-side async job recorded on an `attempts` row:
 * `submitted` until the provider reports an end state; `expired` when the
 * runner gave up waiting (the next attempt polls it again before it submits).
 */
export type JobState = "submitted" | "done" | "failed" | "expired";

/**
 * A provider job a new attempt can adopt instead of submitting again.
 *
 * @example
 * ```ts
 * const live: LiveJob = { externalId: "req-1", jobState: "expired", attemptId: 7 };
 * ```
 */
export type LiveJob = {
  /** Provider job id. */
  externalId: string;
  /** `submitted`, or `expired` when a runner stopped waiting for it. */
  jobState: "submitted" | "expired";
  /** The attempt row the job was found on. */
  attemptId: number;
};

/**
 * A reusable `done` artifact found by artifact key, from any run.
 */
export type DoneArtifact = { contentHash: string; mimeType: string | null };

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
  /** Human label: the build item's `id`, or `<NN>-<task>`. Export file name. */
  label: string;
  /** The build file's `name`. Export folder. */
  buildName: string;
  /** Artifact identity (task, provider, pack, resolved input, params), written at insert. */
  artifactKey: string;
};

/**
 * One `items` row — an `ItemIntent` plus durable state-machine and identity fields.
 */
export type ItemRow = Omit<ItemIntent, "artifactKey" | "label" | "buildName"> & {
  id: string;
  runId: string;
  status: ItemStatus;
  /** Null only on rows written before labels existed. */
  label: string | null;
  /** Null only on rows written before labels existed. */
  buildName: string | null;
  /** MIME type of the committed artifact, when known. */
  mimeType: string | null;
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
  /**
   * Creates the single `runs` row for one invocation (status `active`).
   *
   * @param opts - The invocation's glob label and optional budget cap.
   * @param opts.glob - The invocation's file pattern label.
   * @param opts.maxCostUsd - Optional budget cap, USD.
   * @returns The new run row.
   */
  openRun(opts: { glob: string; maxCostUsd?: number }): RunRow;
  /**
   * Looks up one run by id.
   *
   * @param runId - Run id.
   * @returns The run row, or undefined.
   */
  getRun(runId: string): RunRow | undefined;
  /**
   * Newest run still eligible for resume (`active`, `paused`, `budget-stopped`).
   *
   * @returns The run row, or undefined.
   */
  latestResumableRun(): RunRow | undefined;
  /**
   * Inserts item intents as `queued`, idempotent per (run, planning key).
   *
   * @param runId - Run id the items belong to.
   * @param items - Planning-time intents.
   * @returns The existing or new rows, in input order.
   */
  insertItems(runId: string, items: ItemIntent[]): ItemRow[];
  /**
   * Re-queues every `dispatching` item of a run (resume after a crash or pause).
   *
   * @param runId - Run id.
   * @returns How many items were re-queued.
   */
  requeueDispatching(runId: string): number;
  /**
   * The atomic budget + dedup gate: `queued → dispatching` in one transaction.
   *
   * @param itemId - Item id to admit.
   * @returns `{ ok: true }`, or `{ ok: false, reason }`.
   */
  gateToDispatching(itemId: string): GateResult;
  /**
   * Records the start of a provider attempt.
   *
   * @param itemId - Item id.
   * @param attempt - Provider, account and start time.
   * @returns The new attempt id.
   */
  recordAttempt(itemId: string, attempt: AttemptStart): number;
  /**
   * Records the end of a provider attempt.
   *
   * @param attemptId - Attempt id.
   * @param end - End time, outcome, error class and cost.
   */
  finishAttempt(attemptId: number, end: AttemptEnd): void;
  /**
   * `dispatching → done` with cost, artifact key, content hash and mime type.
   *
   * @param itemId - Item id.
   * @param result - What the attempt produced.
   * @param result.actualCostUsd - Realized cost, USD.
   * @param result.artifactKey - Artifact identity key.
   * @param result.contentHash - CAS content hash.
   * @param result.mimeType - Artifact mime type, when known.
   */
  commitDone(
    itemId: string,
    result: { actualCostUsd: number; artifactKey: string; contentHash: string; mimeType?: string }
  ): void;
  /**
   * Newest `done` artifact with this artifact key, in any run (cross-run reuse).
   *
   * @param artifactKey - Artifact identity key.
   * @returns The artifact, or undefined.
   */
  findDoneArtifact(artifactKey: string): DoneArtifact | undefined;
  /**
   * `queued → done` with a reused artifact at cost 0.
   *
   * @param itemId - Item id.
   * @param artifact - The reused artifact.
   */
  reuseDone(itemId: string, artifact: DoneArtifact): void;
  /**
   * Records a provider job id and/or state on an attempt.
   *
   * @param attemptId - Attempt id.
   * @param job - Job id (optional) and state.
   * @param job.externalId - Provider job id; omit to keep the stored one.
   * @param job.jobState - The job's lifecycle state.
   */
  setAttemptJob(attemptId: number, job: { externalId?: string; jobState: JobState }): void;
  /**
   * Newest adoptable provider job for this artifact key, in any run: still
   * `submitted`, or `expired` at most once, and not failed or done since.
   *
   * @param artifactKey - Artifact identity key.
   * @returns The live job, or undefined.
   */
  findLiveJob(artifactKey: string): LiveJob | undefined;
  /**
   * Newest run of any status.
   *
   * @returns The run row, or undefined.
   */
  latestRun(): RunRow | undefined;
  /**
   * One item of a run by planning key.
   *
   * @param runId - Run id.
   * @param planningKey - Planning key.
   * @returns The item row, or undefined.
   */
  getItem(runId: string, planningKey: string): ItemRow | undefined;
  /**
   * `dispatching → failed` (terminal), or back to `queued` with the attempt count bumped.
   *
   * @param itemId - Item id.
   * @param result - Error class and whether it is terminal.
   * @param result.errorClass - Classification of the failure.
   * @param result.terminal - True for terminal; false to re-queue.
   */
  markFailed(itemId: string, result: { errorClass: ErrorClass; terminal: boolean }): void;
  /**
   * `dispatching → flagged` (content policy, never re-queued).
   *
   * @param itemId - Item id.
   */
  markFlagged(itemId: string): void;
  /**
   * Sets a run's status; records `finished_at` for `done` / `failed`.
   *
   * @param runId - Run id.
   * @param status - New status.
   */
  setRunStatus(runId: string, status: RunStatus): void;
  /**
   * Aggregate counts and spend for a run.
   *
   * @param runId - Run id.
   * @returns The totals.
   */
  totals(runId: string): RunTotals;
  /**
   * A run's items, optionally filtered.
   *
   * @param runId - Run id.
   * @param filter - Status / limit / afterUpdatedAt filter.
   * @returns Matching rows, oldest-updated first.
   */
  listItems(runId: string, filter?: ItemFilter): ItemRow[];
  /**
   * Point-in-time snapshot on a short-lived connection (safe from a second process).
   *
   * @param runId - Run id.
   * @returns Run row, totals and recent items.
   */
  readSnapshot(runId: string): RunSnapshot;
  /** Runs `wal_checkpoint(TRUNCATE)` on the primary connection. */
  checkpoint(): void;
};
