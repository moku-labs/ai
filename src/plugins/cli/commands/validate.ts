/**
 * @file `moku validate [glob]` — build-file validation command skeleton.
 */

/**
 * Runs the `validate` command: buildfile.loadGlob → per-file OK/error table.
 * Exit 0 or 2.
 *
 * @param _context - CommandContext (branded console + required plugin APIs).
 * @param _flags - Parsed command flags.
 * @example
 * ```ts
 * const code = await runValidateCommand(context, flags);
 * ```
 */
export function runValidateCommand(
  _context: unknown,
  _flags: Record<string, string>
): Promise<number> {
  throw new Error("not implemented");
}
