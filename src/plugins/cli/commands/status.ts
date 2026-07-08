/**
 * @file `moku status [runId] [--follow]` — status command skeleton.
 */

/**
 * Runs the `status` command: runner.status snapshot table; --follow polls via
 * short-lived reads on an interval (never one held-open connection). Exit 0.
 *
 * @param _context - CommandContext (branded console + required plugin APIs).
 * @param _flags - Parsed command flags.
 * @example
 * ```ts
 * const code = await runStatusCommand(context, flags);
 * ```
 */
export function runStatusCommand(
  _context: unknown,
  _flags: Record<string, string>
): Promise<number> {
  throw new Error("not implemented");
}
