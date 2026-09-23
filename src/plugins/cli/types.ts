/**
 * @file cli plugin — type definitions.
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import type { BrandConsole } from "@moku-labs/common/cli";
import type { PluginCtx } from "@moku-labs/core";
import type { buildfilePlugin } from "../buildfile";
import type { BuildfileApi } from "../buildfile/types";
import type { composePlugin } from "../compose";
import type { ComposeApi } from "../compose/types";
import type { JournalApi } from "../journal/types";
import type { runnerPlugin } from "../runner";
import type { RunnerApi } from "../runner/types";

/**
 * cli plugin configuration: whether ANSI color/spinners are disabled.
 *
 * @example
 * ```ts
 * const config: Config = { plain: false };
 * ```
 */
export type Config = {
  /** Disable ANSI color/spinners (also auto-disabled when !TTY or NO_COLOR). Default: false. */
  plain: boolean;
};

/**
 * The ratified exit-code contract every `dispatch()` call returns (spec/13-cli.md):
 * 0 success, 1 runtime/run failure, 2 build-file validation error, 3 usage/argument
 * error, 4 clean pause (SIGINT drain), 5 budget stop.
 *
 * @example
 * ```ts
 * return EXIT_CODES.ok;
 * ```
 */
export const EXIT_CODES = {
  ok: 0,
  failure: 1,
  validation: 2,
  usage: 3,
  paused: 4,
  budgetStop: 5
} as const;

/** One flag a command accepts: its `node:util` `parseArgs` type plus a human description. */
export type CommandFlagSpec = {
  /** The `parseArgs` value type: a string-valued flag or a presence-only boolean flag. */
  type: "string" | "boolean";
  /** Human-readable description, surfaced in usage output and {@link CommandTree}. */
  description: string;
};

/**
 * Parsed flag values for one dispatched command. String flags keep their raw
 * value; boolean flags are recorded as the literal `"true"` when present.
 *
 * @example
 * ```ts
 * const flags: CommandFlags = { dryRun: "true", maxCost: "5" };
 * ```
 */
export type CommandFlags = Record<string, string>;

/**
 * The mountable command tree — name, description, and flags per command —
 * exported for a future umbrella CLI to remount under `moku ai <cmd>`.
 *
 * @example
 * ```ts
 * const tree: CommandTree = {
 *   name: "ai",
 *   description: "Moku AI build system commands",
 *   commands: [{ name: "new", description: "Write a starter build file", flags: {} }]
 * };
 * ```
 */
export type CommandTree = {
  name: string;
  description: string;
  commands: Array<{ name: string; description: string; flags: Record<string, string> }>;
};

/**
 * The shared dependency surface every command handler renders through and
 * calls into — built once per `dispatch()` call in `api.ts`. Commands never
 * touch the plugin `ctx` directly and never import each other.
 *
 * @example
 * ```ts
 * export const runNewCommand = async (context: CommandContext): Promise<number> => {
 *   context.ui.info("writing build file…");
 *   return EXIT_CODES.ok;
 * };
 * ```
 */
export type CommandContext = {
  /** The branded console every command renders through (the MC1 seam). */
  ui: BrandConsole;
  /** `app.buildfile` — compile/loadGlob/jsonSchema/template. */
  buildfile: BuildfileApi;
  /** `app.runner` — run/resume/estimate/status/events/export. */
  runner: RunnerApi;
  /** `app.compose` — compose. */
  compose: ComposeApi;
  /** `ctx.journal` — used directly by `status --follow`'s short-lived polling reads. */
  journal: JournalApi;
  /** `ctx.log` — structured diagnostics (MC2). */
  log: LogApi;
  /**
   * Runs `action` with a SIGINT-wired `AbortSignal`: the first Ctrl-C aborts
   * the signal (clean pause via drain); because the listener is installed
   * with `process.once`, a second Ctrl-C falls through to Node's default
   * SIGINT behavior (immediate exit) — durability makes that safe.
   *
   * @param action - The operation to run, given the wired abort signal.
   * @returns `action`'s resolved value.
   */
  runWithAbort<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T>;
};

/**
 * One mountable command: its argv name, description, accepted flags, and
 * handler. The registry `api.ts` assembles from these is the single source
 * for both `dispatch()` routing and the `commands()` tree.
 *
 * @example
 * ```ts
 * const newCommand: CommandDefinition = {
 *   name: "new",
 *   description: "Write a starter build file and JSON Schema",
 *   flags: {},
 *   run: runNewCommand
 * };
 * ```
 */
export type CommandDefinition = {
  name: string;
  description: string;
  flags: Record<string, CommandFlagSpec>;
  run(context: CommandContext, flags: CommandFlags, positionals: string[]): Promise<number>;
};

/**
 * Public API surface of the `cli` plugin, exposed as `app.cli`.
 *
 * @example
 * ```ts
 * const code = await app.cli.dispatch(["validate"]);
 * ```
 */
export type CliApi = {
  /**
   * Parses argv, routes to a command module, renders via the branded
   * console, and translates the outcome to the exit-code contract. Never
   * calls `process.exit` itself — the caller (`bin.ts`) owns the process.
   *
   * @param argv - Command-line arguments, excluding the node/script prefix (e.g. `["run", "--dry-run"]`).
   * @returns The exit code (see {@link EXIT_CODES}).
   */
  dispatch(argv: string[]): Promise<number>;
  /**
   * The mountable command tree, exported for a future umbrella CLI to remount under `moku ai <cmd>`.
   *
   * @returns The command tree.
   */
  commands(): CommandTree;
};

/**
 * `ctx.require` narrowed to cli's three declared dependencies (runner,
 * buildfile, compose), each resolving to its real API type.
 *
 * @example
 * ```ts
 * const requireDeps: CliRequire = ctx.require;
 * requireDeps(runnerPlugin).status();
 * ```
 */
export type CliRequire = ((plugin: typeof runnerPlugin) => RunnerApi) &
  ((plugin: typeof buildfilePlugin) => BuildfileApi) &
  ((plugin: typeof composePlugin) => ComposeApi);

/**
 * Domain context type for the cli API factory: plugin config plus empty
 * state (cli has no lifecycle and no `createState` — OQ1), `require`
 * narrowed to its three dependencies, plus the `journal`/`log`/`env` core
 * APIs the commands need.
 *
 * @example
 * ```ts
 * export const createCliApi = (ctx: CliContext): CliApi => ({ ... });
 * ```
 */
export type CliContext = PluginCtx<Config, Record<string, never>> & {
  require: CliRequire;
  journal: JournalApi;
  log: LogApi;
  env: EnvApi;
};
