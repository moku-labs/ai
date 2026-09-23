/**
 * @file `moku run [glob] [--max-cost <usd>] [--dry-run]` — run command.
 */
import { spinnerFrameAt } from "@moku-labs/common/cli";
import type { RunEvent, RunOptions, RunResult, RunResultStatus } from "../../runner/types";
import type { CommandContext, CommandFlags } from "../types";
import { EXIT_CODES } from "../types";
import { DEFAULT_OUT_DIR, renderExport } from "./export";

/** Terminal run status → exit code (the ratified exit-code contract). */
const EXIT_BY_STATUS: Record<RunResultStatus, number> = {
  done: EXIT_CODES.ok,
  failed: EXIT_CODES.failure,
  paused: EXIT_CODES.paused,
  "budget-stopped": EXIT_CODES.budgetStop
};

/** The outcome of parsing `--max-cost`. */
type MaxCostResult = { ok: true; value: number | undefined } | { ok: false; message: string };

/**
 * Parses `--max-cost`'s raw string value into a non-negative number, or
 * reports a usage error for a missing/negative/non-numeric value.
 *
 * @param raw - The raw `--max-cost` flag value, if given.
 * @returns The parsed value, or a usage-error message.
 * @example
 * ```ts
 * parseMaxCost("5.5"); // { ok: true, value: 5.5 }
 * ```
 */
function parseMaxCost(raw: string | undefined): MaxCostResult {
  if (raw === undefined) return { ok: true, value: undefined };

  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed < 0) {
    return { ok: false, message: `invalid --max-cost value "${raw}"` };
  }
  return { ok: true, value: parsed };
}

/**
 * Builds `runner.run`'s options, omitting each optional field entirely
 * (never setting it to `undefined`) when absent, as required under
 * `exactOptionalPropertyTypes`.
 *
 * @param pattern - The positional glob pattern, if given.
 * @param maxCostUsd - The parsed `--max-cost` value, if given.
 * @param dryRun - Whether `--dry-run` was given.
 * @returns The options to forward to `RunnerApi.run`.
 * @example
 * ```ts
 * buildRunOptions(undefined, 5, true); // { dryRun: true }
 * ```
 */
function buildRunOptions(
  pattern: string | undefined,
  maxCostUsd: number | undefined,
  dryRun: boolean
): RunOptions {
  return {
    ...(pattern === undefined ? {} : { files: pattern }),
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    ...(dryRun ? { dryRun: true } : {})
  };
}

/**
 * Renders one per-item stream event: a spinner-prefixed progress line for
 * coalesced `"progress"` events, and a final branded box for the
 * authoritative `"terminal"` record.
 *
 * @param context - CommandContext (branded console + required plugin APIs).
 * @param startedAt - Epoch ms the render loop began, for the spinner frame.
 * @param event - The stream event to render.
 * @example
 * ```ts
 * renderRunEvent(context, Date.now(), event);
 * ```
 */
function renderRunEvent(context: CommandContext, startedAt: number, event: RunEvent): void {
  if (event.type === "progress") {
    const frame = context.ui.color ? `${spinnerFrameAt(Date.now() - startedAt)} ` : "";
    context.ui.info(
      `${frame}${event.totals.done}/${event.totals.total} done · $${event.totals.spendUsd.toFixed(4)} spent`
    );
    return;
  }

  if (event.type === "terminal") {
    context.ui.box([
      `status   ${event.status}`,
      `done     ${event.totals.done}/${event.totals.total}`,
      `failed   ${event.totals.failed}`,
      `flagged  ${event.totals.flagged}`,
      `spend    $${event.totals.spendUsd.toFixed(4)}`
    ]);
  }
}

/**
 * Drains the run's per-item event stream, rendering coalesced progress and
 * the terminal summary as they arrive.
 *
 * @param context - CommandContext (branded console + required plugin APIs).
 * @param events - The run's per-item event stream (see `RunnerApi.events`).
 * @example
 * ```ts
 * await renderRunEvents(context, context.runner.events());
 * ```
 */
async function renderRunEvents(
  context: CommandContext,
  events: AsyncIterable<RunEvent>
): Promise<void> {
  const startedAt = Date.now();
  for await (const event of events) {
    renderRunEvent(context, startedAt, event);
  }
}

/**
 * Renders the dry-run estimate summary from the run's final result. A dry
 * run never activates the runner's event stream (`runner.run` returns its
 * estimate before subscribing an active run), so the planned-item count and
 * estimated cost are rendered directly from the returned totals.
 *
 * @param context - CommandContext (branded console + required plugin APIs).
 * @param result - The dry run's final result (estimate in `totals.estimatedRemainingUsd`).
 * @example
 * ```ts
 * renderDryRunSummary(context, result);
 * ```
 */
function renderDryRunSummary(context: CommandContext, result: RunResult): void {
  context.ui.box([
    `dry-run  ${result.totals.total} item(s) planned`,
    `estimate $${result.totals.estimatedRemainingUsd.toFixed(4)}`
  ]);
}

/**
 * Starts the run and concurrently drains + renders its event stream.
 * `runner.events()` is opened synchronously right after `runner.run()` is
 * called (before any `await` in this function), which is required to
 * observe the run's `state.active` subscription window.
 *
 * @param context - CommandContext (branded console + required plugin APIs).
 * @param options - The run's options (glob, budget cap, dry-run).
 * @param signal - The SIGINT-wired abort signal.
 * @returns The run's final result.
 * @example
 * ```ts
 * const result = await runAndRenderProgress(context, options, signal);
 * ```
 */
async function runAndRenderProgress(
  context: CommandContext,
  options: RunOptions,
  signal: AbortSignal
): Promise<RunResult> {
  const runPromise = context.runner.run(options, { signal });
  const events = context.runner.events();
  await renderRunEvents(context, events);
  return runPromise;
}

/**
 * Runs the `run` command: `runner.run` with a SIGINT-wired signal, rendering
 * coalesced progress from `runner.events()`. Maps the result's terminal
 * status to the exit-code contract.
 *
 * @param context - CommandContext (branded console + required plugin APIs).
 * @param flags - Parsed command flags (`maxCost`, `dryRun`).
 * @param positionals - Positional args; `positionals[0]` is the glob pattern.
 * @returns The exit code mapped from the run's terminal status, or `EXIT_CODES.usage` for a bad `--max-cost`.
 * @example
 * ```ts
 * const code = await runRunCommand(context, { dryRun: "true" }, []);
 * ```
 */
export async function runRunCommand(
  context: CommandContext,
  flags: CommandFlags,
  positionals: string[]
): Promise<number> {
  const pattern = positionals[0];
  const dryRun = flags.dryRun === "true";
  const maxCostResult = parseMaxCost(flags.maxCost);

  if (!maxCostResult.ok) {
    context.ui.error(maxCostResult.message);
    return EXIT_CODES.usage;
  }

  // Dry runs bypass the event stream (it stays empty — see renderDryRunSummary).
  const options = buildRunOptions(pattern, maxCostResult.value, dryRun);
  const result = await context.runWithAbort(signal =>
    dryRun
      ? context.runner.run(options, { signal })
      : runAndRenderProgress(context, options, signal)
  );

  if (dryRun) {
    renderDryRunSummary(context, result);
    return EXIT_BY_STATUS[result.status];
  }

  // Named files for every done item: out/<build>/<label>.<ext>.
  const exported = await context.runner.export({
    runId: result.runId,
    outDir: flags.out ?? DEFAULT_OUT_DIR
  });
  renderExport(context, exported);
  return EXIT_BY_STATUS[result.status];
}
