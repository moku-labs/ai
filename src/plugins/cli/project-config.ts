/**
 * @file Project config loader for the `moku` bin: finds `moku.config.{ts,mts,js,mjs}` (or the
 * file named by `--config`), imports its default export and hands it back with `--config`
 * removed from argv. Never exits and never creates the app: the bin decides.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BrandConsole } from "@moku-labs/common/cli";
import { createBrandConsole } from "@moku-labs/common/cli";
import type { ProjectConfig } from "../../index";

/** The file names probed in the cwd, in priority order: the first one that exists wins. */
const CONFIG_FILE_NAMES = [
  "moku.config.ts",
  "moku.config.mts",
  "moku.config.js",
  "moku.config.mjs"
];

/** The flag that names the config file explicitly, as `--config <path>` or `--config=<path>`. */
const CONFIG_FLAG = "--config";

/** The `--config=<path>` spelling of the flag. */
const CONFIG_FLAG_PREFIX = `${CONFIG_FLAG}=`;

/** The message for a `--config` flag without a path. */
const MISSING_PATH_MESSAGE =
  "[ai] --config needs a file path.\n  Pass --config <path> or --config=<path>.";

/** The reason given when the `--config` file does not exist. */
const MISSING_FILE_REASON =
  "Check the path, or drop --config to use moku.config.ts in this directory.";

/** The reason given when the default export is not a config object. */
const NOT_AN_OBJECT_REASON =
  "Its default export is not an object: use export default defineConfig({ ... }).";

/**
 * The outcome of {@link loadProjectConfig}: the options for `createApp` plus the argv for
 * `cli.dispatch`, or a ready-to-print message the bin renders before it exits with code 3.
 *
 * @example
 * ```ts
 * const loaded: LoadedProjectConfig = { ok: true, options: {}, argv: ["status"], path: undefined };
 * ```
 */
export type LoadedProjectConfig =
  | {
      /** The config loaded, or no config file exists. */
      ok: true;
      /** The default export of the config file; `{}` when there is no file. */
      options: ProjectConfig;
      /** The argv with `--config` and its value removed. */
      argv: string[];
      /** The absolute path of the loaded file; `undefined` when there is no file. */
      path: string | undefined;
    }
  | {
      /** The config file could not be loaded. */
      ok: false;
      /** `[ai] <description>.\n  <reason>`, ready for {@link renderLoadError}. */
      message: string;
    };

/** The `--config` flag pulled out of argv: the named path (if any) and the remaining tokens. */
type ConfigFlag =
  | { ok: true; configPath: string | undefined; argv: string[] }
  | { ok: false; message: string };

/**
 * Tells whether a token after `--config` is a usable path: present, not empty, not a flag.
 *
 * @param token - The token that should hold the path.
 * @returns `true` when the token names a file.
 * @example
 * ```ts
 * isPathToken("--flat"); // false
 * ```
 */
function isPathToken(token: string | undefined): token is string {
  return token !== undefined && token !== "" && !token.startsWith("-");
}

/**
 * Removes every `--config <path>` / `--config=<path>` from argv. The last one names the file.
 *
 * @param argv - The CLI tokens after the bin name.
 * @returns The named path and the remaining tokens, or a message when a `--config` has no path.
 * @example
 * ```ts
 * extractConfigFlag(["run", "--config=a.ts"]); // { ok: true, configPath: "a.ts", argv: ["run"] }
 * ```
 */
function extractConfigFlag(argv: readonly string[]): ConfigFlag {
  const rest: string[] = [];
  let configPath: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] ?? "";

    // `--config=<path>`: the path rides in the same token.
    if (token.startsWith(CONFIG_FLAG_PREFIX)) {
      configPath = token.slice(CONFIG_FLAG_PREFIX.length);
      if (!isPathToken(configPath)) return { ok: false, message: MISSING_PATH_MESSAGE };
      continue;
    }

    // `--config <path>`: the path is the next token, which is consumed too.
    if (token === CONFIG_FLAG) {
      configPath = argv[index + 1];
      if (!isPathToken(configPath)) return { ok: false, message: MISSING_PATH_MESSAGE };
      index++;
      continue;
    }

    rest.push(token);
  }

  return { ok: true, configPath, argv: rest };
}

/**
 * Finds the first config file in the cwd, in {@link CONFIG_FILE_NAMES} order.
 *
 * @param cwd - The directory to probe.
 * @returns The absolute path of the first file that exists, or `undefined`.
 * @example
 * ```ts
 * findConfigFile("/work/game"); // "/work/game/moku.config.ts"
 * ```
 */
function findConfigFile(cwd: string): string | undefined {
  return CONFIG_FILE_NAMES.map(name => path.resolve(cwd, name)).find(file => existsSync(file));
}

/**
 * Tells whether a default export can be passed to `createApp`: a non-null, non-array object.
 *
 * @param value - The module's default export.
 * @returns `true` for a config object.
 * @example
 * ```ts
 * isConfigObject([]); // false
 * ```
 */
function isConfigObject(value: unknown): value is ProjectConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the message of a thrown value.
 *
 * @param error - The value an import threw.
 * @returns The error message, or the value as text.
 * @example
 * ```ts
 * describeError(new Error("boom")); // "boom"
 * ```
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds the load-failure message for one config file.
 *
 * @param file - The absolute path of the config file.
 * @param reason - Why it could not be loaded.
 * @returns `[ai] Could not load <file>.\n  <reason>`.
 * @example
 * ```ts
 * couldNotLoad("/w/moku.config.ts", "boom"); // "[ai] Could not load /w/moku.config.ts.\n  boom"
 * ```
 */
function couldNotLoad(file: string, reason: string): string {
  return `[ai] Could not load ${file}.\n  ${reason}`;
}

/**
 * Imports a config file and checks its default export.
 *
 * @param file - The absolute path of an existing config file.
 * @returns The config object, or the message that says why it is not one.
 * @example
 * ```ts
 * await importConfig("/w/moku.config.ts"); // { ok: true, options: { pluginConfigs: { ... } } }
 * ```
 */
async function importConfig(
  file: string
): Promise<{ ok: true; options: ProjectConfig } | { ok: false; message: string }> {
  let module: { default?: unknown };
  try {
    module = (await import(pathToFileURL(file).href)) as { default?: unknown };
  } catch (error) {
    return { ok: false, message: couldNotLoad(file, describeError(error)) };
  }

  if (!isConfigObject(module.default)) {
    return { ok: false, message: couldNotLoad(file, NOT_AN_OBJECT_REASON) };
  }
  return { ok: true, options: module.default };
}

/**
 * Loads the project config the `moku` bin passes to `createApp`. A `--config <path>` (or
 * `--config=<path>`) anywhere in argv wins and is removed from the returned argv; the path
 * resolves against `cwd`. Otherwise the first of `moku.config.ts`, `.mts`, `.js`, `.mjs` in
 * `cwd` is used. No file at all is fine: the options are `{}`. A missing `--config` file, an
 * import that throws, or a default export that is not an object is `{ ok: false, message }`.
 * Node 24 strips the types of a `.ts` file natively; Bun loads it as is.
 *
 * @param argv - The CLI tokens after the bin name.
 * @param cwd - The directory to resolve `--config` against and to probe.
 * @returns The options and the cleaned argv, or the message to print.
 * @example
 * ```ts
 * // moku.config.ts holds: export default defineConfig({ pluginConfigs: { ark: { region: "cn" } } });
 * await loadProjectConfig(["status", "--config", "moku.config.ts"], "/work/game");
 * // { ok: true, options: { pluginConfigs: { ark: { region: "cn" } } }, argv: ["status"], path: "/work/game/moku.config.ts" }
 * ```
 */
export async function loadProjectConfig(
  argv: readonly string[],
  cwd: string
): Promise<LoadedProjectConfig> {
  // Take `--config` out of argv: the commands never see it.
  const flag = extractConfigFlag(argv);
  if (!flag.ok) return flag;

  // The named file wins; else probe the cwd. No file keeps today's behaviour.
  const file =
    flag.configPath === undefined ? findConfigFile(cwd) : path.resolve(cwd, flag.configPath);
  if (file === undefined) return { ok: true, options: {}, argv: flag.argv, path: undefined };
  if (!existsSync(file)) return { ok: false, message: couldNotLoad(file, MISSING_FILE_REASON) };

  // Import the file and hand its default export to the bin.
  const loaded = await importConfig(file);
  if (!loaded.ok) return loaded;
  return { ok: true, options: loaded.options, argv: flag.argv, path: file };
}

/**
 * Prints a {@link loadProjectConfig} failure through the branded console (stderr).
 *
 * @param message - The `message` of a failed load.
 * @param ui - The console to print through; the branded default, auto color.
 * @example
 * ```ts
 * // In the bin, before `process.exit(3)`: prints the message to stderr.
 * renderLoadError("[ai] --config needs a file path.\n  Pass --config <path> or --config=<path>.");
 * ```
 */
export function renderLoadError(message: string, ui: BrandConsole = createBrandConsole()): void {
  ui.error(message);
}
