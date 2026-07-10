/**
 * @file `moku status [runId] [--follow]` — status command.
 */
import type { RunSnapshot } from "../../journal/types";
import type { RunStatusReport } from "../../runner/types";
import type { CommandContext, CommandFlags } from "../types";
import { EXIT_CODES } from "../types";

/** Delay between `--follow` polls, ms. */
const POLL_INTERVAL_MS = 1000;
/** Terminal `RunStatus` values `--follow` stops polling on. */
const TERMINAL_STATUSES = new Set(["done", "failed", "paused", "budget-stopped"]);

/**
 * Whether a run status is terminal (the `--follow` loop should stop).
 *
 * @param status - The run's current status.
 * @returns True when `status` is terminal.
 * @example
 * ```ts
 * isTerminalStatus("done"); // true
 * ```
 */
function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Renders one status report as a branded box.
 *
 * @param context - CommandContext (branded console + required plugin APIs).
 * @param report - The status report to render.
 * @example
 * ```ts
 * renderReport(context, context.runner.status());
 * ```
 */
function renderReport(context: CommandContext, report: RunStatusReport): void {
  context.ui.box([
    `run      ${report.runId}`,
    `status   ${report.status}`,
    `done     ${report.totals.done}/${report.totals.total}`,
    `failed   ${report.totals.failed}`,
    `flagged  ${report.totals.flagged}`,
    `spend    $${report.totals.spendUsd.toFixed(4)}`
  ]);
}

/**
 * Converts a `journal.readSnapshot` result into the same report shape
 * `runner.status` returns, so `--follow` renders through {@link renderReport}.
 *
 * @param snapshot - The journal snapshot.
 * @returns The equivalent status report.
 * @example
 * ```ts
 * toReport(context.journal.readSnapshot(runId));
 * ```
 */
function toReport(snapshot: RunSnapshot): RunStatusReport {
  return {
    runId: snapshot.run.id,
    status: snapshot.run.status,
    totals: snapshot.totals,
    updatedAt: snapshot.recentItems[0]?.updatedAt ?? snapshot.run.createdAt
  };
}

/**
 * A real-timer delay, injected into {@link pollUntilTerminal} by default so
 * tests can substitute an immediate fake instead of waiting on wall-clock time.
 *
 * @param ms - Delay in milliseconds.
 * @returns Resolves after `ms` milliseconds.
 * @example
 * ```ts
 * await defaultSleep(1000);
 * ```
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Polls `journal.readSnapshot` on an interval — each read is a short-lived,
 * one-shot call (NEVER one held-open connection, the WAL
 * checkpoint-starvation mitigation) — rendering the snapshot every tick,
 * until the run reaches a terminal status.
 *
 * @param context - CommandContext (branded console + required plugin APIs).
 * @param runId - The run to follow.
 * @param intervalMs - Delay between polls, ms.
 * @param sleep - Injectable delay function (a real timer by default).
 * @example
 * ```ts
 * await pollUntilTerminal(context, "run-1", 1000);
 * ```
 */
export async function pollUntilTerminal(
  context: CommandContext,
  runId: string,
  intervalMs: number,
  sleep: (ms: number) => Promise<void> = defaultSleep
): Promise<void> {
  for (;;) {
    const snapshot = context.journal.readSnapshot(runId);
    renderReport(context, toReport(snapshot));
    if (isTerminalStatus(snapshot.run.status)) return;
    await sleep(intervalMs);
  }
}

/**
 * Runs the `status` command: renders a `runner.status` snapshot table, or
 * with `--follow`, polls `journal.readSnapshot` on an interval until the run
 * finishes (see {@link pollUntilTerminal}).
 *
 * @param context - CommandContext (branded console + required plugin APIs).
 * @param flags - Parsed command flags (`follow`).
 * @param positionals - Positional args; `positionals[0]` is the run id.
 * @returns `EXIT_CODES.ok`.
 * @example
 * ```ts
 * const code = await runStatusCommand(context, { follow: "true" }, ["run-1"]);
 * ```
 */
export async function runStatusCommand(
  context: CommandContext,
  flags: CommandFlags,
  positionals: string[]
): Promise<number> {
  const runId = positionals[0];
  const follow = flags.follow === "true";

  if (!follow) {
    renderReport(context, context.runner.status(runId));
    return EXIT_CODES.ok;
  }

  const targetRunId = runId ?? context.runner.status().runId;
  await pollUntilTerminal(context, targetRunId, POLL_INTERVAL_MS);
  return EXIT_CODES.ok;
}
