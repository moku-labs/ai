/**
 * @file `moku run [glob] [--max-cost <usd>] [--dry-run]` — run command skeleton.
 */

/**
 * Runs the `run` command: runner.run with a SIGINT-wired signal; renders
 * coalesced progress from runner.events(). Maps result status → exit code
 * (done→0, failed→1, paused→4, budget-stopped→5).
 *
 * @param _context - CommandContext (branded console + required plugin APIs).
 * @param _flags - Parsed command flags.
 * @example
 * ```ts
 * const code = await runRunCommand(context, flags);
 * ```
 */
export function runRunCommand(_context: unknown, _flags: Record<string, string>): Promise<number> {
  throw new Error("not implemented");
}
