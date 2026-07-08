/**
 * @file `moku compose "<prompt>" [--emit build|script] [--out <path>]` — compose command skeleton.
 */

/**
 * Runs the `compose` command: compose.compose → writes the emitted file (or
 * prints to stdout). Exit 0 / 1 / 2 (invalid after repairs).
 *
 * @param _context - CommandContext (branded console + required plugin APIs).
 * @param _flags - Parsed command flags.
 * @example
 * ```ts
 * const code = await runComposeCommand(context, flags);
 * ```
 */
export function runComposeCommand(
  _context: unknown,
  _flags: Record<string, string>
): Promise<number> {
  throw new Error("not implemented");
}
