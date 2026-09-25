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
 * runner gave up waiting or hit an unclassified poll error (the next attempt
 * polls it again before it submits; after two expiries it submits anew).
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
   * @example
   * ```ts
   * // runner run(): one runs row per invocation, capped at $25
   * const run = ctx.journal.openRun({ glob: "voice/*.yaml", maxCostUsd: 25 });
   * // run.status === "active", run.maxCostUsd === 25, run.finishedAt === null
   * ctx.journal.openRun({ glob: "voice/*.yaml" }).maxCostUsd; // null: no cap
   * ```
   */
  openRun(opts: { glob: string; maxCostUsd?: number }): RunRow;
  /**
   * Looks up one run by id.
   *
   * @param runId - Run id.
   * @returns The run row, or undefined.
   * @example
   * ```ts
   * // runner export(runId): the run the caller named, or a clear error
   * const run = ctx.journal.openRun({ glob: "voice/*.yaml" });
   * ctx.journal.getRun(run.id); // equal to run
   * ctx.journal.getRun("does-not-exist"); // undefined
   * ```
   */
  getRun(runId: string): RunRow | undefined;
  /**
   * Newest run still eligible for resume (`active`, `paused`, `budget-stopped`)
   * whose id is not in `exclude`. Omitted or empty `exclude` skips nothing.
   *
   * @param opts - Optional filter.
   * @param opts.exclude - Run ids to skip, such as the runs this process drives now.
   * @returns The run row, or undefined.
   * @example
   * ```ts
   * // runner resume(): pick the newest resumable run it is not driving now
   * const driving = [...ctx.state.active.keys()];
   * const target = ctx.journal.latestResumableRun({ exclude: driving });
   * if (!target) {
   *   throw new Error("[ai] No resumable run found.\n  Start a new run with run() instead.");
   * }
   * ctx.journal.requeueDispatching(target.id);
   * ```
   */
  latestResumableRun(opts?: { exclude?: readonly string[] }): RunRow | undefined;
  /**
   * Inserts item intents as `queued`, idempotent per (run, planning key).
   *
   * @param runId - Run id the items belong to.
   * @param items - Planning-time intents.
   * @returns The existing or new rows, in input order.
   * @example
   * ```ts
   * // runner run(): planned items enter as queued; resume inserts them again and gets the same rows
   * const intent = { planningKey: "pk-1", buildFile: "voice/intro.yaml", task: "voiceover",
   *   provider: "elevenlabs", packVersion: null, estimatedCostUsd: 0.4, label: "intro",
   *   buildName: "intro", artifactKey: "ak-1" };
   * const [item] = ctx.journal.insertItems(run.id, [intent]); // status "queued", attemptCount 0
   * ctx.journal.insertItems(run.id, [intent]); // [the same row]: no second insert
   * ```
   */
  insertItems(runId: string, items: ItemIntent[]): ItemRow[];
  /**
   * Re-queues every `dispatching` item of a run (resume after a crash or pause).
   *
   * @param runId - Run id.
   * @returns How many items were re-queued.
   * @example
   * ```ts
   * // runner resume(): items a crash left in flight go back to the queue
   * const target = ctx.journal.latestResumableRun({ exclude: [] });
   * if (target) ctx.journal.requeueDispatching(target.id); // 2 when two items were dispatching
   * // 0 when nothing was dispatching
   * ```
   */
  requeueDispatching(runId: string): number;
  /**
   * The atomic budget + dedup gate: `queued → dispatching` in one transaction.
   *
   * @param itemId - Item id to admit.
   * @returns `{ ok: true }`, or `{ ok: false, reason }`.
   * @example
   * ```ts
   * // runner, before each provider call: admit the item, or stop on the budget
   * const gate = ctx.journal.gateToDispatching(item.id); // { ok: true }: item is now dispatching
   * if (!gate.ok && gate.reason === "budget") drain.triggerBudgetStop();
   * ctx.journal.gateToDispatching(item.id); // { ok: false, reason: "duplicate" }: already admitted
   * ```
   */
  gateToDispatching(itemId: string): GateResult;
  /**
   * Records the start of a provider attempt.
   *
   * @param itemId - Item id.
   * @param attempt - Provider, account and start time.
   * @returns The new attempt id.
   * @example
   * ```ts
   * // runner, right after the gate: one attempts row per provider call
   * const attemptId = ctx.journal.recordAttempt(item.id, {
   *   provider: "elevenlabs", account: "default", startedAt: Date.now()
   * }); // 1 for the first attempt in a fresh journal
   * ```
   */
  recordAttempt(itemId: string, attempt: AttemptStart): number;
  /**
   * Records the end of a provider attempt.
   *
   * @param attemptId - Attempt id.
   * @param end - End time, outcome, error class and cost.
   * @example
   * ```ts
   * // runner, when the handler settles: close the attempt with its outcome and cost
   * ctx.journal.finishAttempt(attemptId, { endedAt: Date.now(), outcome: "done", costUsd: 0.2 });
   * // or, on a rate limit (the item itself is moved by markFailed):
   * ctx.journal.finishAttempt(attemptId, { endedAt: Date.now(), outcome: "retryable-error", errorClass: "http-429" });
   * ```
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
   * @example
   * ```ts
   * // runner, after store.put(): the bytes are durable, so the item can be done
   * const { hash } = await ctx.store.put(bytes);
   * ctx.journal.commitDone(item.id, { actualCostUsd: 0.2, artifactKey: "ak-1", contentHash: hash, mimeType: "audio/mpeg" });
   * // ctx.journal.totals(run.id).spendUsd grows by 0.2; a no-op when the item is not dispatching
   * ```
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
   * @example
   * ```ts
   * // runner, before the gate: an artifact any earlier run made is reused, not paid again
   * ctx.journal.findDoneArtifact("ak-1"); // { contentHash: "2cf24dba…", mimeType: "audio/mpeg" }
   * ctx.journal.findDoneArtifact("ak-never-built"); // undefined
   * ```
   */
  findDoneArtifact(artifactKey: string): DoneArtifact | undefined;
  /**
   * `queued → done` with a reused artifact at cost 0.
   *
   * @param itemId - Item id.
   * @param artifact - The reused artifact.
   * @example
   * ```ts
   * // runner tryReuse(): a queued item takes a finished artifact at cost 0
   * const hit = ctx.journal.findDoneArtifact("ak-1");
   * if (hit && (await ctx.store.has(hit.contentHash))) ctx.journal.reuseDone(item.id, hit);
   * // item is now done with actualCostUsd 0; a no-op when the item was not queued
   * ```
   */
  reuseDone(itemId: string, artifact: DoneArtifact): void;
  /**
   * Records a provider job id and/or state on an attempt.
   *
   * @param attemptId - Attempt id.
   * @param job - Job id (optional) and state.
   * @param job.externalId - Provider job id; omit to keep the stored one.
   * @param job.jobState - The job's lifecycle state.
   * @example
   * ```ts
   * // runner, right after handler.submit(): journal the job id before any wait
   * ctx.journal.setAttemptJob(attemptId, { externalId: "req-1", jobState: "submitted" });
   * ctx.journal.findLiveJob("ak-1"); // { externalId: "req-1", jobState: "submitted", attemptId }
   * ctx.journal.setAttemptJob(attemptId, { jobState: "done" }); // id kept; findLiveJob("ak-1") is undefined
   * ```
   */
  setAttemptJob(attemptId: number, job: { externalId?: string; jobState: JobState }): void;
  /**
   * Newest adoptable provider job for this artifact key, in any run: still
   * `submitted`, or `expired` at most once, and not failed or done since.
   *
   * @param artifactKey - Artifact identity key.
   * @returns The live job, or undefined.
   * @example
   * ```ts
   * // runner, before submit(): adopt the job a crashed or paused run left with the provider
   * const live = ctx.journal.findLiveJob("ak-1"); // { externalId: "req-1", jobState: "submitted", attemptId: 7 }
   * if (live) ctx.journal.setAttemptJob(attemptId, { externalId: live.externalId, jobState: "submitted" });
   * // undefined when the job failed, finished, or expired twice: the next attempt submits anew
   * ```
   */
  findLiveJob(artifactKey: string): LiveJob | undefined;
  /**
   * Newest run of any status.
   *
   * @returns The run row, or undefined.
   * @example
   * ```ts
   * // runner export() with no run id: export the newest run, whatever its status
   * const run = ctx.journal.latestRun(); // { id, status: "done", glob: "voice/*.yaml", … }
   * if (!run) throw new Error("[ai] No run to export.\n  Run a build first."); // empty journal
   * ```
   */
  latestRun(): RunRow | undefined;
  /**
   * One item of a run by planning key.
   *
   * @param runId - Run id.
   * @param planningKey - Planning key.
   * @returns The item row, or undefined.
   * @example
   * ```ts
   * // runner: a `$ref` target must be done before the item that refers to it can start
   * const target = ctx.journal.getItem(item.runId, "pk-keyframe"); // undefined when not planned
   * if (target?.status !== "done" || target.contentHash === null) return; // blocked: wait
   * ctx.store.pathOf(target.contentHash); // the reference file for the handler
   * ```
   */
  getItem(runId: string, planningKey: string): ItemRow | undefined;
  /**
   * `dispatching → failed` (terminal), or back to `queued` with the attempt count bumped.
   *
   * @param itemId - Item id.
   * @param result - Error class and whether it is terminal.
   * @param result.errorClass - Classification of the failure.
   * @param result.terminal - True for terminal; false to re-queue.
   * @example
   * ```ts
   * // runner, after a failed attempt of a dispatching item:
   * ctx.journal.markFailed(item.id, { errorClass: "http-5xx", terminal: false }); // queued, attemptCount + 1
   * // or, for a deterministic error:
   * ctx.journal.markFailed(item.id, { errorClass: "http-4xx", terminal: true }); // failed, never retried
   * ```
   */
  markFailed(itemId: string, result: { errorClass: ErrorClass; terminal: boolean }): void;
  /**
   * `dispatching → flagged` (content policy, never re-queued).
   *
   * @param itemId - Item id.
   * @example
   * ```ts
   * // runner, when the provider refuses the prompt on content policy
   * ctx.journal.finishAttempt(attemptId, { endedAt: Date.now(), outcome: "flagged", errorClass: "content-policy" });
   * ctx.journal.markFlagged(item.id); // item is flagged; resume never re-queues it
   * ```
   */
  markFlagged(itemId: string): void;
  /**
   * Sets a run's status; records `finished_at` for `done` / `failed`.
   *
   * @param runId - Run id.
   * @param status - New status.
   * @example
   * ```ts
   * // runner, when the pipeline drains: record how the run ended
   * ctx.journal.setRunStatus(run.id, "done"); // finishedAt is set to now
   * // or, when a signal paused it:
   * ctx.journal.setRunStatus(run.id, "paused"); // finishedAt stays null; latestResumableRun() finds it
   * ```
   */
  setRunStatus(runId: string, status: RunStatus): void;
  /**
   * Aggregate counts and spend for a run.
   *
   * @param runId - Run id.
   * @returns The totals.
   * @example
   * ```ts
   * // runner progress: 3 items (estimates 0.5, 0.25, 0.75), the first done at $0.40, the second dispatching
   * ctx.journal.totals(run.id);
   * // { total: 3, queued: 1, dispatching: 1, done: 1, failed: 0, flagged: 0, spendUsd: 0.4, estimatedRemainingUsd: 1 }
   * ```
   */
  totals(runId: string): RunTotals;
  /**
   * A run's items, optionally filtered.
   *
   * @param runId - Run id.
   * @param filter - Status / limit / afterUpdatedAt filter.
   * @returns Matching rows, oldest-updated first.
   * @example
   * ```ts
   * // runner resume(): continue every item still queued
   * ctx.journal.listItems(run.id, { status: "queued" }); // ItemRow[], oldest-updated first
   * // runner export(): only the finished artifacts
   * ctx.journal.listItems(run.id, { status: "done", limit: 50 }); // at most 50 rows
   * ```
   */
  listItems(runId: string, filter?: ItemFilter): ItemRow[];
  /**
   * Point-in-time snapshot on a short-lived connection (safe from a second process).
   *
   * @param runId - Run id.
   * @returns Run row, totals and recent items.
   * @example
   * ```ts
   * // cli `status --follow`: poll the run once a second on a short-lived connection
   * ctx.journal.readSnapshot(run.id);
   * // { run: { status: "active", … }, totals: { total: 2, done: 1, queued: 1, … }, recentItems: [newest first, max 20] }
   * ctx.journal.readSnapshot("no-such-run"); // throws "[ai] Run not found: no-such-run. …"
   * ```
   */
  readSnapshot(runId: string): RunSnapshot;
  /**
   * Runs `wal_checkpoint(TRUNCATE)` on the primary connection. The same checkpoint runs every
   * `checkpointIntervalMs` and once on stop.
   *
   * @example
   * ```ts
   * // A backup plugin copies .moku/journal.db: fold the WAL into the main file first
   * ctx.journal.checkpoint(); // journal.db holds every committed write; journal.db-wal stays, truncated
   * ```
   */
  checkpoint(): void;
};
