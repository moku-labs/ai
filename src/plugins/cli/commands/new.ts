/**
 * @file `moku new [name]` — build-file + JSON Schema scaffolding command skeleton.
 */

/**
 * Runs the `new` command: writes `<name>.moku.yaml` from buildfile.template()
 * and refreshes the JSON Schema file. Refuses to overwrite (exit 1).
 *
 * @param _context - CommandContext (branded console + required plugin APIs).
 * @param _flags - Parsed command flags.
 * @example
 * ```ts
 * const code = await runNewCommand(context, flags);
 * ```
 */
export function runNewCommand(_context: unknown, _flags: Record<string, string>): Promise<number> {
  throw new Error("not implemented");
}
