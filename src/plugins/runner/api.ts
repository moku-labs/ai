/**
 * @file runner API factory — assembles `run`/`resume`/`estimate`/`status`/
 * `events` from the domain modules (plan, pipeline, retry, stream). Owns run-
 * level orchestration: opening/resuming the single `runs` row, driving every
 * queued item concurrently, coalesced progress, and the terminal transition.
 */
import { buildfilePlugin } from "../buildfile";
import type { ItemRow, RunRow, RunTotals } from "../journal/types";
import { createDrainController, executeItem } from "./pipeline";
import { planItems } from "./plan";
import { clearActiveRun } from "./state";
import { broadcastEvent, closeAllSubscribers, createEventQueue } from "./stream";
import type {
  ActiveRun,
  EstimateResult,
  PlannedItem,
  RunnerApi,
  RunnerContext,
  RunOptions,
  RunResult,
  RunResultStatus,
  RunStatusReport
} from "./types";

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
 * Guards against starting a second concurrent run in this process (M0:
 * single active run per process).
 *
 * @param ctx - Runner domain context.
 * @throws {Error} When a run is already active.
 * @example
 * ```ts
 * ensureNoActiveRun(ctx);
 * ```
 */
function ensureNoActiveRun(ctx: RunnerContext): void {
  if (ctx.state.active) {
    throw new Error(
      `[ai] A run is already active: ${ctx.state.active.runId}.\n  Wait for it to finish before starting another run() or resume().`
    );
  }
}

/**
 * Looks up a run by id, throwing the documented not-found error when absent.
 *
 * @param ctx - Runner domain context.
 * @param runId - Run id to look up.
 * @returns The run row.
 * @throws {Error} When no run with `runId` exists.
 * @example
 * ```ts
 * const run = requireRun(ctx, runId);
 * ```
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
 * Computes this run's totals, pushes a `"progress"` stream record to every
 * subscriber, and emits the coalesced `run:progress` bus event.
 *
 * @param ctx - Runner domain context.
 * @param runId - The run to compute totals for.
 * @param active - The active run's live bookkeeping.
 * @example
 * ```ts
 * pushProgress(ctx, runId, active);
 * ```
 */
function pushProgress(ctx: RunnerContext, runId: string, active: ActiveRun): void {
  const totals = ctx.journal.totals(runId);
  broadcastEvent(active, { type: "progress", totals });
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
 * @param active - The active run's live bookkeeping.
 * @param error - The caught error.
 * @returns The failed run's result.
 * @example
 * ```ts
 * return failRun(ctx, run, active, error);
 * ```
 */
function failRun(ctx: RunnerContext, run: RunRow, active: ActiveRun, error: unknown): RunResult {
  const totals = ctx.journal.totals(run.id);
  ctx.journal.setRunStatus(run.id, "failed");
  const message = error instanceof Error ? error.message : String(error);

  broadcastEvent(active, { type: "terminal", status: "failed", totals });
  closeAllSubscribers(active);
  ctx.emit("run:failed", { runId: run.id, error: message });

  return { runId: run.id, status: "failed", totals };
}

/**
 * Picks a run's final status from its drain controller: a budget-stop takes
 * priority over a plain external-signal pause; otherwise the run is `done`.
 *
 * @param drain - The run's drain controller.
 * @returns The run's final (non-`failed`) status.
 * @example
 * ```ts
 * const status = finalStatusOf(drain);
 * ```
 */
function finalStatusOf(drain: ReturnType<typeof createDrainController>): RunResultStatus {
  if (drain.budgetStopped) return "budget-stopped";
  if (drain.signal.aborted) return "paused";
  return "done";
}

/**
 * Drives every queued item of a run concurrently to a terminal outcome,
 * coalescing progress and delivering the final `"terminal"` stream record
 * and bus event.
 *
 * @param ctx - Runner domain context.
 * @param run - The run row (used for its id and `maxCostUsd`).
 * @param items - The run's current item rows (only `queued` ones are driven).
 * @param active - The active run's live bookkeeping.
 * @param planned - Planned items, keyed by planning key, for request/maxAttempts lookup.
 * @returns The run's final result.
 * @example
 * ```ts
 * const result = await drivePipeline(ctx, run, items, active, planned);
 * ```
 */
async function drivePipeline(
  ctx: RunnerContext,
  run: RunRow,
  items: ItemRow[],
  active: ActiveRun,
  planned: PlannedItem[]
): Promise<RunResult> {
  const plannedByPlanningKey = new Map(planned.map(p => [p.intent.planningKey, p] as const));
  const queued = items.filter(item => item.status === "queued");
  const drain = createDrainController(active.signal);

  let lastProgressAt = 0;
  /**
   * Broadcasts one per-item stream record to every subscriber, then
   * opportunistically flushes a throttled `run:progress` update (≤1 per
   * {@link PROGRESS_COALESCE_MS}).
   *
   * @param event - The per-item stream record to broadcast.
   * @example
   * ```ts
   * report({ type: "item:dispatching", itemId: "i1" });
   * ```
   */
  const report = (event: Parameters<typeof broadcastEvent>[1]): void => {
    broadcastEvent(active, event);
    const now = Date.now();
    if (!shouldEmitProgress(lastProgressAt, now)) return;
    lastProgressAt = now;
    pushProgress(ctx, run.id, active);
  };

  await Promise.all(
    queued.map(item => {
      const plan = plannedByPlanningKey.get(item.planningKey);
      if (!plan) {
        ctx.log.warn("runner:stale-item", { itemId: item.id, planningKey: item.planningKey });
        return Promise.resolve();
      }
      return executeItem(ctx, item, plan.request, plan.maxAttempts, drain, active, report);
    })
  );

  pushProgress(ctx, run.id, active);
  const totals = ctx.journal.totals(run.id);
  const status = finalStatusOf(drain);
  ctx.journal.setRunStatus(run.id, status);

  broadcastEvent(active, { type: "terminal", status, totals });
  closeAllSubscribers(active);

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
 * @example
 * ```ts
 * const result = await dryRunEstimate(ctx, options);
 * ```
 */
async function dryRunEstimate(ctx: RunnerContext, options: RunOptions): Promise<RunResult> {
  const builds = await ctx.require(buildfilePlugin).loadGlob(options.files);
  const planned = planItems(ctx, builds);
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
 * {@link dryRunEstimate} — no journal writes.
 *
 * @param ctx - Runner domain context.
 * @param options - Run options (glob, budget cap, dry-run).
 * @param opts - Optional external abort signal for a clean pause.
 * @param opts.signal - Abort signal; on abort, stop admitting queued items and resolve `{ status: "paused" }` once in-flight items drain.
 * @returns The run's final result.
 * @example
 * ```ts
 * const result = await run(ctx, { files: "voice/*.moku.yaml" });
 * ```
 */
async function run(
  ctx: RunnerContext,
  options: RunOptions,
  opts?: { signal?: AbortSignal }
): Promise<RunResult> {
  ensureNoActiveRun(ctx);
  if (options.dryRun) return dryRunEstimate(ctx, options);

  const globLabel = options.files ?? DEFAULT_GLOB_LABEL;
  const openedRun =
    options.maxCostUsd === undefined
      ? ctx.journal.openRun({ glob: globLabel })
      : ctx.journal.openRun({ glob: globLabel, maxCostUsd: options.maxCostUsd });

  const active: ActiveRun = {
    runId: openedRun.id,
    signal: opts?.signal,
    subscribers: new Set(),
    inFlight: 0
  };
  ctx.state.active = active;

  try {
    const builds = await ctx.require(buildfilePlugin).loadGlob(options.files);
    const planned = planItems(ctx, builds);
    const items = ctx.journal.insertItems(
      openedRun.id,
      planned.map(p => p.intent)
    );
    return await drivePipeline(ctx, openedRun, items, active, planned);
  } catch (error) {
    return failRun(ctx, openedRun, active, error);
  } finally {
    clearActiveRun(ctx.state);
  }
}

/**
 * Continues the latest resumable run (or a specific one by id):
 * `requeueDispatching` re-queues any items left mid-flight, then re-enters
 * the pipeline for every currently queued item. Re-planning is idempotent
 * (`insertItems` no-ops on existing planning keys), so already-`done` items
 * are never re-billed.
 *
 * @param ctx - Runner domain context.
 * @param opts - Optional run id (else the latest resumable run) and abort signal.
 * @param opts.runId - Run id to resume; defaults to the latest resumable run.
 * @param opts.signal - Abort signal; on abort, stop admitting queued items and resolve `{ status: "paused" }` once in-flight items drain.
 * @returns The run's final result.
 * @throws {Error} When no resumable run exists.
 * @example
 * ```ts
 * const result = await resume(ctx);
 * ```
 */
async function resume(
  ctx: RunnerContext,
  opts?: { runId?: string; signal?: AbortSignal }
): Promise<RunResult> {
  ensureNoActiveRun(ctx);
  const targetRun = opts?.runId ? requireRun(ctx, opts.runId) : ctx.journal.latestResumableRun();
  if (!targetRun) {
    throw new Error("[ai] No resumable run found.\n  Start a new run with run() instead.");
  }
  ctx.journal.requeueDispatching(targetRun.id);

  const active: ActiveRun = {
    runId: targetRun.id,
    signal: opts?.signal,
    subscribers: new Set(),
    inFlight: 0
  };
  ctx.state.active = active;

  try {
    const pattern = targetRun.glob === DEFAULT_GLOB_LABEL ? undefined : targetRun.glob;
    const builds = await ctx.require(buildfilePlugin).loadGlob(pattern);
    const planned = planItems(ctx, builds);
    ctx.journal.insertItems(
      targetRun.id,
      planned.map(p => p.intent)
    );
    const items = ctx.journal.listItems(targetRun.id, { status: "queued" });
    return await drivePipeline(ctx, targetRun, items, active, planned);
  } catch (error) {
    return failRun(ctx, targetRun, active, error);
  } finally {
    clearActiveRun(ctx.state);
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
 * @example
 * ```ts
 * const estimate = await estimate(ctx, { files: "voice/*.moku.yaml" });
 * ```
 */
async function estimate(ctx: RunnerContext, options: { files?: string }): Promise<EstimateResult> {
  const builds = await ctx.require(buildfilePlugin).loadGlob(options.files);
  const planned = planItems(ctx, builds);

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
 * active run, else the latest resumable run. Uses `journal.readSnapshot`,
 * which is safe to call from a second process.
 *
 * @param ctx - Runner domain context.
 * @param runId - Run id to report on; defaults to the active/latest resumable run.
 * @returns The run's status report.
 * @throws {Error} When no run id is given and none can be inferred.
 * @example
 * ```ts
 * const report = status(ctx);
 * ```
 */
function status(ctx: RunnerContext, runId?: string): RunStatusReport {
  const targetId = runId ?? ctx.state.active?.runId ?? ctx.journal.latestResumableRun()?.id;
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
 * Opens a per-item detail stream for the active run. Returns an
 * already-closed empty stream when no run is active. See stream.ts for the
 * bounded-buffer/overflow/coalescing contract.
 *
 * @param ctx - Runner domain context.
 * @returns An async iterable of per-item stream records.
 * @example
 * ```ts
 * for await (const event of events(ctx)) ctx.log.debug("runner:event", event);
 * ```
 */
function events(ctx: RunnerContext): ReturnType<typeof createEventQueue> {
  const queue = createEventQueue(ctx.config.eventBufferSize);
  if (ctx.state.active) {
    ctx.state.active.subscribers.add(queue);
  } else {
    queue.close();
  }
  return queue;
}

/**
 * Creates the runner API surface (run/resume/estimate/status/events),
 * binding each method to the domain context.
 *
 * @param ctx - Runner domain context (config, state, emit, require, core APIs).
 * @returns The runner's public API.
 * @example
 * ```ts
 * const api = createRunnerApi(ctx);
 * ```
 */
export function createRunnerApi(ctx: RunnerContext): RunnerApi {
  return {
    /**
     * Executes one durable run. See {@link run}.
     *
     * @param options - Run options (glob, budget cap, dry-run).
     * @param opts - Optional external abort signal for a clean pause.
     * @returns The run's final result.
     * @example
     * ```ts
     * await app.runner.run({ files: "voice/*.moku.yaml" });
     * ```
     */
    run: (options, opts) => run(ctx, options, opts),
    /**
     * Continues the latest (or a specific) resumable run. See {@link resume}.
     *
     * @param opts - Optional run id and abort signal.
     * @returns The run's final result.
     * @example
     * ```ts
     * await app.runner.resume();
     * ```
     */
    resume: opts => resume(ctx, opts),
    /**
     * Computes the same per-item estimate the budget gate uses. See {@link estimate}.
     *
     * @param options - Glob options.
     * @returns The per-task/provider cost breakdown and its total.
     * @example
     * ```ts
     * await app.runner.estimate({ files: "voice/*.moku.yaml" });
     * ```
     */
    estimate: options => estimate(ctx, options),
    /**
     * Reads a read-only status snapshot. See {@link status}.
     *
     * @param runId - Run id to report on; defaults to the active/latest resumable run.
     * @returns The run's status report.
     * @example
     * ```ts
     * app.runner.status();
     * ```
     */
    status: runId => status(ctx, runId),
    /**
     * Opens a per-item detail stream for the active run. See {@link events}.
     *
     * @returns An async iterable of per-item stream records.
     * @example
     * ```ts
     * for await (const event of app.runner.events()) ctx.log.debug("runner:event", event);
     * ```
     */
    events: () => events(ctx)
  };
}
