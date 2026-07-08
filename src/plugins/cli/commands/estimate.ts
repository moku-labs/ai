/**
 * @file `moku estimate [glob]` — cost estimate command skeleton.
 */

/**
 * Runs the `estimate` command: runner.estimate → per-task/provider cost
 * breakdown + total in a branded box. Exit 0.
 *
 * @param _context - CommandContext (branded console + required plugin APIs).
 * @param _flags - Parsed command flags.
 * @example
 * ```ts
 * const code = await runEstimateCommand(context, flags);
 * ```
 */
export function runEstimateCommand(
  _context: unknown,
  _flags: Record<string, string>
): Promise<number> {
  throw new Error("not implemented");
}
