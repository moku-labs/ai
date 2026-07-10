/**
 * @file `moku validate [glob]` — build-file validation command.
 */

import type { CommandContext, CommandFlags } from "../types";
import { EXIT_CODES } from "../types";

/** Label rendered on a failed row when no explicit glob was given. */
const DEFAULT_LABEL = "build files";

/**
 * Runs the `validate` command: `buildfile.loadGlob` against the given (or
 * configured default) glob, rendering one OK row per compiled build file.
 * `loadGlob` rejects on the first invalid file (or an empty match), which is
 * rendered as a single failing row.
 *
 * @param context - CommandContext (branded console + required plugin APIs).
 * @param _flags - Parsed command flags (unused — `validate` takes no flags).
 * @param positionals - Positional args; `positionals[0]` is the glob pattern.
 * @returns The exit code: `EXIT_CODES.ok` when every matched file validates, else `EXIT_CODES.validation`.
 * @example
 * ```ts
 * const code = await runValidateCommand(context, {}, ["**\/*.moku.yaml"]);
 * ```
 */
export async function runValidateCommand(
  context: CommandContext,
  _flags: CommandFlags,
  positionals: string[]
): Promise<number> {
  const pattern = positionals[0];

  try {
    const builds = await context.buildfile.loadGlob(pattern);
    for (const build of builds) {
      context.ui.check(true, build.file);
    }
    return EXIT_CODES.ok;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.ui.check(false, pattern ?? DEFAULT_LABEL, message);
    return EXIT_CODES.validation;
  }
}
