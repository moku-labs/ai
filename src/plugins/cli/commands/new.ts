/**
 * @file `moku new [name]` — build-file + JSON Schema scaffolding command.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CommandContext, CommandFlags } from "../types";
import { EXIT_CODES } from "../types";

/** Matches `buildfile.template()`'s first-line yaml-language-server modeline. */
const MODELINE_PATTERN = /^# yaml-language-server: \$schema=(.+)$/;
/** Build-file base name used when the caller omits a positional `name`. */
const DEFAULT_BUILD_NAME = "build";

/**
 * Extracts the `$schema=<path>` target from `buildfile.template()`'s
 * modeline, so `new` writes the JSON Schema file the emitted build file's
 * modeline points at, without duplicating `buildfile`'s own `schemaPath`
 * config onto this plugin.
 *
 * @param templateText - The rendered build-file template text.
 * @returns The schema path from the modeline's `$schema=` target.
 * @throws {Error} When `templateText` doesn't start with the expected modeline.
 * @example
 * ```ts
 * schemaPathFromTemplate(context.buildfile.template({ name: "demo" }));
 * ```
 */
function schemaPathFromTemplate(templateText: string): string {
  const [modeline] = templateText.split("\n");
  const match = modeline === undefined ? undefined : MODELINE_PATTERN.exec(modeline);

  if (match?.[1] === undefined) {
    throw new Error(
      '[ai] "new" could not derive a schema path from buildfile.template().\n  Ensure buildfile.template() still starts with the yaml-language-server modeline.'
    );
  }

  return match[1];
}

/**
 * Whether a file already exists at `filePath`.
 *
 * @param filePath - Absolute or relative path to check.
 * @returns True when the file exists.
 * @example
 * ```ts
 * await fileExists("demo.moku.yaml");
 * ```
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs the `new` command: writes `<name>.moku.yaml` from
 * `buildfile.template()` AND writes/refreshes the JSON Schema file the
 * emitted modeline points at. Refuses to overwrite an existing build file.
 *
 * @param context - CommandContext (branded console + required plugin APIs).
 * @param _flags - Parsed command flags (unused — `new` takes no flags).
 * @param positionals - Positional args; `positionals[0]` is the build name (default `"build"`).
 * @returns The exit code: `EXIT_CODES.ok` on success, `EXIT_CODES.failure` on overwrite refusal.
 * @example
 * ```ts
 * const code = await runNewCommand(context, {}, ["demo"]);
 * ```
 */
export async function runNewCommand(
  context: CommandContext,
  _flags: CommandFlags,
  positionals: string[]
): Promise<number> {
  const name = positionals[0] ?? DEFAULT_BUILD_NAME;
  const buildFilePath = `${name}.moku.yaml`;

  if (await fileExists(buildFilePath)) {
    context.ui.error(`refusing to overwrite existing build file "${buildFilePath}"`);
    return EXIT_CODES.failure;
  }

  const template = context.buildfile.template({ name });
  const schemaPath = schemaPathFromTemplate(template);

  await writeFile(buildFilePath, template, "utf8");
  await mkdir(path.dirname(schemaPath), { recursive: true });
  await writeFile(schemaPath, JSON.stringify(context.buildfile.jsonSchema(), undefined, 2), "utf8");

  context.ui.check(true, `wrote ${buildFilePath}`);
  context.ui.check(true, `wrote ${schemaPath}`);
  return EXIT_CODES.ok;
}
