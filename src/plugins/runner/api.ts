/**
 * @file runner API factory — assembles `run`/`resume`/`estimate`/`status`/
 * `events`/`export` from the domain modules (plan, pipeline, retry, stream,
 * export). Owns run-level orchestration: the `maxActiveRuns` guards,
 * opening/resuming a `runs` row, driving every queued item concurrently,
 * coalesced progress, the terminal transition, and closing the run's streams.
 */
import { buildfilePlugin } from "../buildfile";
import type { ItemRow, RunRow, RunTotals } from "../journal/types";
import { exportRun } from "./export";
import type { ItemSettlement } from "./pipeline";
import { createDrainController, executeItem } from "./pipeline";
import { planItems } from "./plan";
import { addActiveRun, removeActiveRun } from "./state";
import { broadcastEvent, closeSubscribers, createEventQueue, stampRunId } from "./stream";
import type {
  ActiveRun,
  EstimateResult,
  PlannedItem,
  RunEvent,
  RunnerApi,
  RunnerContext,
  RunOptions,
  RunResult,
  RunResultStatus,
  RunStatusReport,
  Subscriber,
  UnstampedRunEvent
} from "./types";

/** Options `run()` accepts next to its {@link RunOptions}. */
type RunCallOptions = { signal?: AbortSignal; onStart?: (runId: string) => void };
/** Options `resume()` accepts. */
type ResumeOptions = RunCallOptions & { runId?: string };

/** Label recorded as a run's `glob` when the caller omitted an explicit pattern. */
const DEFAULT_GLOB_LABEL = "(default)";
/** Synthetic runId returned by a `dryRun: true` call (no journal row is opened). */
const DRY_RUN_ID = "dry-run";
/** Minimum interval between coalesced `run:progress` bus emissions, ms. */
const PROGRESS_COALESCE_MS = 500;

/**
 * The progress-coalescing throttle rule: whether enough time has elapsed
 * since the last `run:progress` emission to emit another one (≤1 per
 * {@link PROGRESS_COALESCE_MS}, ratified OQ7).
 *
 * @param lastProgressAt - Epoch ms of the last emission (0 if none yet).
 * @param now - Current epoch ms.
 * @returns True once at least {@link PROGRESS_COALESCE_MS} ms have elapsed.
 * @example
 * ```ts
 * shouldEmitProgress(0, 500); // => true
 * ```
 */
export function shouldEmitProgress(lastProgressAt: number, now: number): boolean {
  return now - lastProgressAt >= PROGRESS_COALESCE_MS;
}

/**
 * Whether a `maxActiveRuns` value is usable: a whole number of at least 1.
 *
 * @param value - The configured cap.
 * @returns True for 1, 2, 3, …
 * @example
 * ```ts
 * isValidRunCap(1.5); // false
 * ```
 */
function isValidRunCap(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

/**
 * The first two guards of `run()` and `resume()`, in order: the cap must be
 * a whole number >= 1, and fewer than `maxActiveRuns` runs may be active.
 * With the default cap of 1 the refusal's first line is the one-run message.
 *
 * @param ctx - Runner domain context.
 * @throws {Error} When `maxActiveRuns` is invalid or already reached.
 */
function ensureRunCapacity(ctx: RunnerContext): void {
  const cap = ctx.config.maxActiveRuns;
  if (!isValidRunCap(cap)) {
    throw new Error(
      `[ai] runner.maxActiveRuns must be a whole number >= 1, got ${String(cap)}.\n  Fix the runner config.`
    );
  }

  if (ctx.state.active.size >= cap) {
    const activeIds = [...ctx.state.active.keys()].join(", ");
    throw new Error(
      `[ai] A run is already active: ${activeIds}.\n  maxActiveRuns is ${cap}. Wait for a run to finish, or raise runner.maxActiveRuns.`
    );
  }
}

/**
 * The third guard of `resume()`: a run this process drives now is followed,
 * never resumed a second time. Reachable only when the cap is above 1.
 *
 * @param ctx - Runner domain context.
 * @param runId - The run asked for.
 * @throws {Error} When `runId` is active in this process.
 */
function ensureNotActive(ctx: RunnerContext, runId: string): void {
  if (ctx.state.active.has(runId)) {
    throw new Error(
      `[ai] Run is already active in this process: ${runId}.\n  Follow it with events({ runId }) instead of resuming it.`
    );
  }
}

/**
 * Registers a run as active and tells the caller its id. `onStart` runs
 * synchronously, before the first `await` of `run()`/`resume()`, so a stream
 * it opens sees every record of the run. Call it inside the run's `try`: a
 * throwing `onStart` fails the run like any other error.
 *
 * @param ctx - Runner domain context.
 * @param runId - The run starting now.
 * @param opts - The caller's signal and start callback.
 * @returns The run's live bookkeeping.
 */
function startActiveRun(
  ctx: RunnerContext,
  runId: string,
  opts: RunCallOptions | undefined
): ActiveRun {
  const active = addActiveRun(ctx.state, runId, opts?.signal);
  opts?.onStart?.(runId);
  return active;
}

/**
 * Ends a run in this process: frees its slot, closes its streams (and the
 * all-runs streams when it was the last active run), then resolves the run's
 * `settled`, so a waiting `app.stop()` continues.
 *
 * @param ctx - Runner domain context.
 * @param runId - The run that ended.
 */
function finishActiveRun(ctx: RunnerContext, runId: string): void {
  const active = ctx.state.active.get(runId);
  removeActiveRun(ctx.state, runId);
  closeSubscribers(ctx.state, runId);
  active?.settle();
}

/**
 * Looks up a run by id, throwing the documented not-found error when absent.
 *
 * @param ctx - Runner domain context.
 * @param runId - Run id to look up.
 * @returns The run row.
 * @throws {Error} When no run with `runId` exists.
 */
function requireRun(ctx: RunnerContext, runId: string): RunRow {
  const run = ctx.journal.getRun(runId);
  if (!run) {
    throw new Error(
      `[ai] Run not found: ${runId}.\n  Verify the run id came from a previous run() or resume() call.`
    );
  }
  return run;
}

/**
 * Computes this run's totals, pushes a `"progress"` stream record to the
 * consumers that follow the run, and emits the coalesced `run:progress` bus
 * event.
 *
 * @param ctx - Runner domain context.
 * @param runId - The run to compute totals for.
 */
function pushProgress(ctx: RunnerContext, runId: string): void {
  const totals = ctx.journal.totals(runId);
  broadcastEvent(ctx.state, { type: "progress", runId, totals });
  ctx.emit("run:progress", {
    runId,
    total: totals.total,
    done: totals.done,
    failed: totals.failed,
    flagged: totals.flagged,
    spendUsd: totals.spendUsd
  });
}

/**
 * Handles an unrecoverable top-level error from `run()`/`resume()`: marks
 * the run `failed`, delivers a `"terminal"` stream record, emits
 * `run:failed`, and resolves (never rejects) with a `{ status: "failed" }` result.
 *
 * @param ctx - Runner domain context.
 * @param run - The run that failed.
 * @param error - The caught error.
 * @returns The failed run's result.
 */
function failRun(ctx: RunnerContext, run: RunRow, error: unknown): RunResult {
  const totals = ctx.journal.totals(run.id);
  ctx.journal.setRunStatus(run.id, "failed");
  const message = error instanceof Error ? error.message : String(error);

  broadcastEvent(ctx.state, { type: "terminal", runId: run.id, status: "failed", totals });
  ctx.emit("run:failed", { runId: run.id, error: message });

  return { runId: run.id, status: "failed", totals };
}

/**
 * Picks a run's final status from its drain controller: a budget-stop takes
 * priority over a plain external-signal pause; an item blocked by a `$ref`
 * target that did not finish also leaves the run `paused` (resumable once
 * the target is fixed); otherwise the run is `done`.
 *
 * @param drain - The run's drain controller.
 * @param blocked - How many items were blocked by an unfinished `$ref` target.
 * @returns The run's final (non-`failed`) status.
 * @example
 * ```ts
 * finalStatusOf(drain, 2); // "paused": two items waited on a $ref target that did not finish
 * ```
 */
function finalStatusOf(
  drain: ReturnType<typeof createDrainController>,
  blocked: number
): RunResultStatus {
  if (drain.budgetStopped) return "budget-stopped";
  if (drain.signal.aborted || blocked > 0) return "paused";
  return "done";
}

/**
 * Starts every queued item in plan order, each waiting for its `$ref`
 * targets' settle promises (D10), and resolves with how each one settled.
 *
 * @param ctx - Runner domain context.
 * @param queued - The run's queued item rows.
 * @param planned - Planned items, dependencies first.
 * @param drain - The run's drain controller.
 * @param active - The active run's live bookkeeping.
 * @param report - Stream callback; the run stamps its runId.
 * @returns One settlement per started item.
 */
function startItems(
  ctx: RunnerContext,
  queued: ItemRow[],
  planned: PlannedItem[],
  drain: ReturnType<typeof createDrainController>,
  active: ActiveRun,
  report: (event: UnstampedRunEvent) => void
): Promise<ItemSettlement[]> {
  const queuedByKey = new Map(queued.map(item => [item.planningKey, item] as const));
  const settledByKey = new Map<string, Promise<ItemSettlement>>();

  for (const item of queued) {
    if (!planned.some(p => p.intent.planningKey === item.planningKey)) {
      ctx.log.warn("runner:stale-item", { itemId: item.id, planningKey: item.planningKey });
    }
  }

  for (const plan of planned) {
    const item = queuedByKey.get(plan.intent.planningKey);
    if (!item || settledByKey.has(item.planningKey)) continue;

    const dependencies = Promise.all(
      [...plan.refKeys.values()].map(key => settledByKey.get(key) ?? Promise.resolve())
    );
    settledByKey.set(
      item.planningKey,
      executeItem(ctx, item, plan, drain, active, report, dependencies)
    );
  }

  return Promise.all(settledByKey.values());
}

/**
 * Drives every queued item of a run concurrently to a terminal outcome,
 * coalescing progress and delivering the final `"terminal"` stream record
 * and bus event. The drain fires on the caller's signal or on `app.stop()`.
 *
 * @param ctx - Runner domain context.
 * @param run - The run row (used for its id and `maxCostUsd`).
 * @param items - The run's current item rows (only `queued` ones are driven).
 * @param active - The active run's live bookkeeping.
 * @param planned - Planned items, keyed by planning key, for request/maxAttempts lookup.
 * @returns The run's final result.
 */
async function drivePipeline(
  ctx: RunnerContext,
  run: RunRow,
  items: ItemRow[],
  active: ActiveRun,
  planned: PlannedItem[]
): Promise<RunResult> {
  const queued = items.filter(item => item.status === "queued");
  // A caller abort and app.stop() drain the run the same way.
  const stopSignals = active.signal ? [active.signal, active.stop.signal] : [active.stop.signal];
  const drain = createDrainController(AbortSignal.any(stopSignals));

  let lastProgressAt = 0;
  /**
   * Stamps one per-item record with this run's id and broadcasts it to the
   * consumers that follow the run, then opportunistically flushes a
   * throttled `run:progress` update (≤1 per {@link PROGRESS_COALESCE_MS}).
   *
   * @param event - The per-item stream record, without its runId.
   * @example
   * ```ts
   * report({ type: "item:dispatching", itemId: "i1" }); // consumers get it with runId: run.id
   * ```
   */
  const report = (event: UnstampedRunEvent): void => {
    const stamped: RunEvent = stampRunId(run.id, event);
    broadcastEvent(ctx.state, stamped);
    const now = Date.now();
    if (!shouldEmitProgress(lastProgressAt, now)) return;
    lastProgressAt = now;
    pushProgress(ctx, run.id);
  };

  const settlements = await startItems(ctx, queued, planned, drain, active, report);
  const blocked = settlements.filter(settlement => settlement === "blocked").length;

  pushProgress(ctx, run.id);
  const totals = ctx.journal.totals(run.id);
  const status = finalStatusOf(drain, blocked);
  ctx.journal.setRunStatus(run.id, status);

  broadcastEvent(ctx.state, { type: "terminal", runId: run.id, status, totals });

  if (status === "budget-stopped") {
    ctx.emit("run:budget-stop", {
      runId: run.id,
      spendUsd: totals.spendUsd,
      maxCostUsd: run.maxCostUsd ?? 0
    });
  } else if (status === "paused") {
    ctx.emit("run:paused", {
      runId: run.id,
      drained: totals.done + totals.failed + totals.flagged
    });
  } else {
    ctx.emit("run:done", { runId: run.id, totals });
  }

  return { runId: run.id, status, totals };
}

/**
 * Computes the same per-item estimate arithmetic the budget gate uses,
 * without opening a journal run: plans the matched build files and totals
 * their estimated costs, grouped by task/provider.
 *
 * @param ctx - Runner domain context.
 * @param options - Glob options.
 * @returns The dry-run's `done` result, with `estimatedRemainingUsd` set to the plan's total.
 */
async function dryRunEstimate(ctx: RunnerContext, options: RunOptions): Promise<RunResult> {
  const builds = await ctx.require(buildfilePlugin).loadGlob(options.files);
  const planned = await planItems(ctx, builds);
  const totalUsd = planned.reduce((sum, p) => sum + p.intent.estimatedCostUsd, 0);

  const totals: RunTotals = {
    total: planned.length,
    queued: 0,
    dispatching: 0,
    done: 0,
    failed: 0,
    flagged: 0,
    spendUsd: 0,
    estimatedRemainingUsd: totalUsd
  };

  return { runId: DRY_RUN_ID, status: "done", totals };
}

/**
 * Executes one durable run: opens a single `runs` journal row spanning
 * every glob-matched build file, plans and inserts every item, then drives
 * the pipeline to completion. `dryRun: true` short-circuits to
 * {@link dryRunEstimate} — no journal writes. The run is active from before
 * its first `await` until it settles; `opts.onStart` gets its id then.
 *
 * @param ctx - Runner domain context.
 * @param options - Run options (glob, budget cap, dry-run).
 * @param opts - Optional external abort signal and start callback.
 * @param opts.signal - Abort signal; on abort, stop admitting queued items and resolve `{ status: "paused" }` once in-flight items drain.
 * @param opts.onStart - Called once, synchronously, with the new run id.
 * @returns The run's final result.
 * @throws {Error} When `maxActiveRuns` is invalid or already reached.
 */
async function run(
  ctx: RunnerContext,
  options: RunOptions,
  opts?: RunCallOptions
): Promise<RunResult> {
  ensureRunCapacity(ctx);
  if (options.dryRun) return dryRunEstimate(ctx, options);

  const globLabel = options.files ?? DEFAULT_GLOB_LABEL;
  const openedRun =
    options.maxCostUsd === undefined
      ? ctx.journal.openRun({ glob: globLabel })
      : ctx.journal.openRun({ glob: globLabel, maxCostUsd: options.maxCostUsd });

  try {
    const active = startActiveRun(ctx, openedRun.id, opts);
    const builds = await ctx.require(buildfilePlugin).loadGlob(options.files);
    const planned = await planItems(ctx, builds);
    const items = ctx.journal.insertItems(
      openedRun.id,
      planned.map(p => p.intent)
    );
    return await drivePipeline(ctx, openedRun, items, active, planned);
  } catch (error) {
    return failRun(ctx, openedRun, error);
  } finally {
    finishActiveRun(ctx, openedRun.id);
  }
}

/**
 * Picks the run `resume()` continues: the given id, else the newest
 * resumable run that this process does not drive now.
 *
 * @param ctx - Runner domain context.
 * @param runId - The run asked for, if any.
 * @returns The target run row.
 * @throws {Error} When the given run does not exist, or no run can be resumed.
 */
function resumeTarget(ctx: RunnerContext, runId: string | undefined): RunRow {
  const exclude = [...ctx.state.active.keys()];
  const targetRun = runId ? requireRun(ctx, runId) : ctx.journal.latestResumableRun({ exclude });
  if (!targetRun) {
    throw new Error("[ai] No resumable run found.\n  Start a new run with run() instead.");
  }
  return targetRun;
}

/**
 * Continues the latest resumable run (or a specific one by id), also while
 * other runs are active: `requeueDispatching` re-queues any items left
 * mid-flight, then re-enters the pipeline for every currently queued item.
 * Re-planning is idempotent (`insertItems` no-ops on existing planning
 * keys), so already-`done` items are never re-billed.
 *
 * @param ctx - Runner domain context.
 * @param opts - Optional run id (else the newest resumable run not active here), abort signal and start callback.
 * @param opts.runId - Run id to resume; defaults to the newest resumable run this process does not drive.
 * @param opts.signal - Abort signal; on abort, stop admitting queued items and resolve `{ status: "paused" }` once in-flight items drain.
 * @param opts.onStart - Called once, synchronously, with the run id.
 * @returns The run's final result.
 * @throws {Error} When `maxActiveRuns` is invalid or reached, the run is already active here, or no resumable run exists.
 */
async function resume(ctx: RunnerContext, opts?: ResumeOptions): Promise<RunResult> {
  ensureRunCapacity(ctx);
  if (opts?.runId) ensureNotActive(ctx, opts.runId);
  const targetRun = resumeTarget(ctx, opts?.runId);
  ctx.journal.requeueDispatching(targetRun.id);

  try {
    const active = startActiveRun(ctx, targetRun.id, opts);
    const pattern = targetRun.glob === DEFAULT_GLOB_LABEL ? undefined : targetRun.glob;
    const builds = await ctx.require(buildfilePlugin).loadGlob(pattern);
    const planned = await planItems(ctx, builds);
    ctx.journal.insertItems(
      targetRun.id,
      planned.map(p => p.intent)
    );
    const items = ctx.journal.listItems(targetRun.id, { status: "queued" });
    return await drivePipeline(ctx, targetRun, items, active, planned);
  } catch (error) {
    return failRun(ctx, targetRun, error);
  } finally {
    finishActiveRun(ctx, targetRun.id);
  }
}

/**
 * Computes the same per-item estimate the budget gate uses: plans the
 * matched build files and totals their estimated costs by task/provider.
 * Performs no journal writes.
 *
 * @param ctx - Runner domain context.
 * @param options - Glob options.
 * @param options.files - Glob pattern; defaults to the buildfile plugin's configured default.
 * @returns The per-task/provider cost breakdown and its total.
 */
async function estimate(ctx: RunnerContext, options: { files?: string }): Promise<EstimateResult> {
  const builds = await ctx.require(buildfilePlugin).loadGlob(options.files);
  const planned = await planItems(ctx, builds);

  const lines = new Map<string, EstimateResult["lines"][number]>();
  for (const p of planned) {
    const key = `${p.intent.task}/${p.intent.provider}`;
    const existing = lines.get(key);
    if (existing) {
      existing.items += 1;
      existing.usd += p.intent.estimatedCostUsd;
    } else {
      lines.set(key, {
        task: p.intent.task,
        provider: p.intent.provider,
        items: 1,
        usd: p.intent.estimatedCostUsd
      });
    }
  }

  const lineList = [...lines.values()];
  const totalUsd = lineList.reduce((sum, line) => sum + line.usd, 0);
  return { lines: lineList, totalUsd };
}

/**
 * Reads a read-only status snapshot for a run: the given `runId`, else the
 * newest active run, else the latest resumable run. Uses
 * `journal.readSnapshot`, which is safe to call from a second process.
 *
 * @param ctx - Runner domain context.
 * @param runId - Run id to report on; defaults to the newest active/latest resumable run.
 * @returns The run's status report.
 * @throws {Error} When no run id is given and none can be inferred.
 */
function status(ctx: RunnerContext, runId?: string): RunStatusReport {
  const newestActive = [...ctx.state.active.keys()].at(-1);
  const targetId = runId ?? newestActive ?? ctx.journal.latestResumableRun()?.id;
  if (!targetId) {
    throw new Error("[ai] No run to report status for.\n  Pass a runId, or start a run first.");
  }

  const snapshot = ctx.journal.readSnapshot(targetId);
  const updatedAt = snapshot.recentItems[0]?.updatedAt ?? snapshot.run.createdAt;
  return {
    runId: snapshot.run.id,
    status: snapshot.run.status,
    totals: snapshot.totals,
    updatedAt
  };
}

/**
 * Whether a stream opened now has records to follow: the given run is
 * active, or (no run id) any run is active.
 *
 * @param ctx - Runner domain context.
 * @param runId - The run to follow, or undefined for every run.
 * @returns True when the stream stays open.
 */
function hasRunToFollow(ctx: RunnerContext, runId: string | undefined): boolean {
  return runId === undefined ? ctx.state.active.size > 0 : ctx.state.active.has(runId);
}

/**
 * Opens a per-item detail stream: one run's records (closed after that run
 * ends), or every run's records (closed once no run is active). Returns an
 * already-closed empty stream when there is nothing to follow. See stream.ts
 * for the bounded-buffer/overflow/coalescing contract.
 *
 * @param ctx - Runner domain context.
 * @param opts - Optional run to follow.
 * @param opts.runId - Follow only this run.
 * @returns An async iterable of per-item stream records.
 */
function events(
  ctx: RunnerContext,
  opts?: { runId?: string }
): ReturnType<typeof createEventQueue> {
  const runId = opts?.runId;
  /**
   * Removes this consumer from runner state when it stops iterating early.
   *
   * @example
   * ```ts
   * for await (const event of events(ctx)) break; // the consumer is no longer broadcast to
   * ```
   */
  const detach = (): void => {
    ctx.state.subscribers.delete(subscriber);
  };
  const queue = createEventQueue(ctx.config.eventBufferSize, detach);
  const subscriber: Subscriber = { queue, runId };
  if (!hasRunToFollow(ctx, runId)) {
    queue.close();
    return queue;
  }

  ctx.state.subscribers.add(subscriber);
  return queue;
}

/**
 * Creates the runner API surface (run/resume/estimate/status/events/export),
 * binding each method to the domain context. The contract of each method is
 * documented on {@link RunnerApi}.
 *
 * @param ctx - Runner domain context (config, state, emit, require, core APIs).
 * @returns The runner's public API.
 */
export function createRunnerApi(ctx: RunnerContext): RunnerApi {
  return {
    run: (options, opts) => run(ctx, options, opts),
    resume: opts => resume(ctx, opts),
    estimate: options => estimate(ctx, options),
    status: runId => status(ctx, runId),
    events: opts => events(ctx, opts),
    export: opts => exportRun(ctx, opts)
  };
}
