/**
 * @file `moku estimate [glob]` — cost estimate command.
 */

import type { CommandContext, CommandFlags } from "../types";
import { EXIT_CODES } from "../types";

/**
 * Builds `runner.estimate`'s options, omitting `files` entirely (never
 * setting it to `undefined`) when no glob was given, as required under
 * `exactOptionalPropertyTypes`.
 *
 * @param pattern - The positional glob pattern, if given.
 * @returns The options to forward to `RunnerApi.estimate`.
 * @example
 * ```ts
 * toEstimateOptions(undefined); // {}
 * ```
 */
function toEstimateOptions(pattern: string | undefined): { files?: string } {
  return pattern === undefined ? {} : { files: pattern };
}

/**
 * Runs the `estimate` command: `runner.estimate` → a per-task/provider cost
 * breakdown plus its total, rendered in a branded box.
 *
 * @param context - CommandContext (branded console + required plugin APIs).
 * @param _flags - Parsed command flags (unused — `estimate` takes no flags).
 * @param positionals - Positional args; `positionals[0]` is the glob pattern.
 * @returns `EXIT_CODES.ok`.
 * @example
 * ```ts
 * const code = await runEstimateCommand(context, {}, ["**\/*.moku.yaml"]);
 * ```
 */
export async function runEstimateCommand(
  context: CommandContext,
  _flags: CommandFlags,
  positionals: string[]
): Promise<number> {
  const pattern = positionals[0];
  const result = await context.runner.estimate(toEstimateOptions(pattern));

  const lines = result.lines.map(line =>
    context.ui.railLine(
      `  ${line.task}/${line.provider} × ${line.items}`,
      `$${line.usd.toFixed(4)}`
    )
  );
  lines.push(context.ui.railLine("  total", `$${result.totalUsd.toFixed(4)}`));
  context.ui.box(lines);

  return EXIT_CODES.ok;
}
