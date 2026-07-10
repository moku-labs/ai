/**
 * @file cli plugin — API factory: builds the command registry + shared
 * `CommandContext` once, then `dispatch()` parses argv, routes to a command,
 * and translates its outcome to the exit-code contract. Never calls
 * `process.exit` — `bin.ts` owns the process (post-start dispatch, OQ1).
 */
import { parseArgs } from "node:util";
import { buildfilePlugin } from "../buildfile";
import { composePlugin } from "../compose";
import { runnerPlugin } from "../runner";
import { runComposeCommand } from "./commands/compose";
import { runEstimateCommand } from "./commands/estimate";
import { runNewCommand } from "./commands/new";
import { runRunCommand } from "./commands/run";
import { runStatusCommand } from "./commands/status";
import { runValidateCommand } from "./commands/validate";
import { createCliConsole } from "./render";
import type {
  CliApi,
  CliContext,
  CommandContext,
  CommandDefinition,
  CommandFlagSpec,
  CommandFlags,
  CommandTree
} from "./types";
import { EXIT_CODES } from "./types";

/** The mountable command tree — the single source for both `dispatch()` routing and `commands()`. */
const COMMAND_REGISTRY: CommandDefinition[] = [
  {
    name: "new",
    description: "Write a starter build file and JSON Schema",
    flags: {},
    run: runNewCommand
  },
  {
    name: "validate",
    description: "Validate build files against the schema",
    flags: {},
    run: runValidateCommand
  },
  {
    name: "estimate",
    description: "Estimate the cost of matched build files",
    flags: {},
    run: runEstimateCommand
  },
  {
    name: "run",
    description: "Run matched build files",
    flags: {
      "max-cost": { type: "string", description: "Maximum spend in USD before the run stops" },
      "dry-run": { type: "boolean", description: "Estimate without executing" }
    },
    run: runRunCommand
  },
  {
    name: "status",
    description: "Report the status of a run",
    flags: {
      follow: { type: "boolean", description: "Poll for updates until the run finishes" }
    },
    run: runStatusCommand
  },
  {
    name: "compose",
    description: "Generate a build file from a natural-language prompt",
    flags: {
      emit: { type: "string", description: 'Output format: "build" or "script"' },
      out: { type: "string", description: "File path to write the emitted text to" }
    },
    run: runComposeCommand
  }
];

/**
 * Converts a kebab-case CLI flag name (as typed after `--`) to the camelCase
 * key a command handler reads off {@link CommandFlags} (e.g. `"max-cost"` → `"maxCost"`).
 *
 * @param flagName - The kebab-case flag name.
 * @returns The camelCase key.
 * @example
 * ```ts
 * toCamelCase("max-cost"); // "maxCost"
 * ```
 */
function toCamelCase(flagName: string): string {
  return flagName.replaceAll(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/**
 * Builds the `node:util` `parseArgs` `options` map from a command's declared
 * {@link CommandFlagSpec} table (drops the human description).
 *
 * @param flags - The command's declared flags.
 * @returns The `parseArgs`-shaped options map.
 * @example
 * ```ts
 * toParseArgsOptions({ "dry-run": { type: "boolean", description: "…" } });
 * ```
 */
function toParseArgumentsOptions(
  flags: Record<string, CommandFlagSpec>
): Record<string, { type: "string" | "boolean" }> {
  const options: Record<string, { type: "string" | "boolean" }> = {};
  for (const [flagName, spec] of Object.entries(flags)) {
    options[flagName] = { type: spec.type };
  }
  return options;
}

/** The outcome of parsing one command's argv slice. */
type ParsedCommandArguments =
  | { ok: true; flags: CommandFlags; positionals: string[] }
  | { ok: false; message: string };

/**
 * Parses one command's argv slice against its declared flags via
 * `node:util`'s `parseArgs`, normalizing flag keys to camelCase. Any
 * `parseArgs` failure (unknown flag, missing string value) is reported as a
 * usage error rather than thrown.
 *
 * @param command - The routed command definition.
 * @param argv - The argv slice after the command name.
 * @returns The parsed flags/positionals, or a usage-error message.
 * @example
 * ```ts
 * parseCommandArgs(runCommand, ["--dry-run"]);
 * ```
 */
function parseCommandArguments(command: CommandDefinition, argv: string[]): ParsedCommandArguments {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: toParseArgumentsOptions(command.flags),
      allowPositionals: true,
      strict: true
    });

    const flags: CommandFlags = {};
    for (const [flagName, value] of Object.entries(values)) {
      if (value === undefined) continue;
      flags[toCamelCase(flagName)] = String(value);
    }

    return { ok: true, flags, positionals };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message };
  }
}

/**
 * Renders the top-level usage listing (unknown/missing command) through the
 * branded console: a lockup banner plus one rail line per registered command.
 *
 * @param context - The shared command context.
 * @param commands - The registered commands to list.
 * @example
 * ```ts
 * renderUsage(context, COMMAND_REGISTRY);
 * ```
 */
function renderUsage(context: CommandContext, commands: CommandDefinition[]): void {
  context.ui.lockup({ wordmark: "moku ai" });
  context.ui.heading("Commands");
  for (const command of commands) {
    context.ui.info(context.ui.railLine(`  ${command.name}`, command.description));
  }
}

/**
 * Builds the mountable {@link CommandTree} from the command registry, for a
 * future umbrella CLI to remount under `moku ai <cmd>`.
 *
 * @param commands - The registered commands.
 * @returns The command tree.
 * @example
 * ```ts
 * toCommandTree(COMMAND_REGISTRY);
 * ```
 */
function toCommandTree(commands: CommandDefinition[]): CommandTree {
  return {
    name: "ai",
    description: "Moku AI build system commands",
    commands: commands.map(command => ({
      name: command.name,
      description: command.description,
      flags: Object.fromEntries(
        Object.entries(command.flags).map(([flagName, spec]) => [flagName, spec.description])
      )
    }))
  };
}

/**
 * Runs `action` with a SIGINT-wired {@link AbortSignal}. The handler is
 * installed with `process.once`, so it fires (and self-removes) on the
 * first Ctrl-C, aborting the signal for a clean pause; a second Ctrl-C then
 * has no registered listener and falls through to Node's default SIGINT
 * behavior (immediate process exit) — never a `process.exit` call from this
 * plugin. The listener is always removed once `action` settles.
 *
 * @param action - The operation to run, given the wired abort signal.
 * @returns `action`'s resolved value.
 * @example
 * ```ts
 * await runWithAbort(signal => context.runner.run(options, { signal }));
 * ```
 */
export async function runWithAbort<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  /**
   * Aborts `controller`'s signal — installed with `process.once` so it
   * fires (and self-removes) on the first SIGINT only.
   *
   * @example
   * ```ts
   * process.once("SIGINT", handleSigint);
   * ```
   */
  const handleSigint = (): void => {
    controller.abort();
  };

  process.once("SIGINT", handleSigint);
  try {
    return await action(controller.signal);
  } finally {
    process.removeListener("SIGINT", handleSigint);
  }
}

/**
 * Resolves whether the branded console should render in plain (no ANSI)
 * mode: an explicit `config.plain`, a non-TTY stdout, or `NO_COLOR` set in
 * the environment (read via `ctx.env`, MC3).
 *
 * @param ctx - The cli plugin's domain context.
 * @returns True when rendering must stay plain.
 * @example
 * ```ts
 * isPlainMode(ctx); // true in CI
 * ```
 */
export function isPlainMode(ctx: CliContext): boolean {
  return ctx.config.plain || process.stdout.isTTY !== true || ctx.env.get("NO_COLOR") !== undefined;
}

/**
 * Assembles the shared {@link CommandContext} every command renders through
 * and calls into, resolving each dependency once via `ctx.require`.
 *
 * @param ctx - The cli plugin's domain context.
 * @returns The shared command context.
 * @example
 * ```ts
 * const context = buildCommandContext(ctx);
 * ```
 */
function buildCommandContext(ctx: CliContext): CommandContext {
  return {
    ui: createCliConsole(isPlainMode(ctx)),
    buildfile: ctx.require(buildfilePlugin),
    runner: ctx.require(runnerPlugin),
    compose: ctx.require(composePlugin),
    journal: ctx.journal,
    log: ctx.log,
    runWithAbort
  };
}

/**
 * Routes one dispatched argv to its command, parses flags, runs the
 * handler, and maps any uncaught error to the generic runtime-failure exit
 * code. An empty or unrecognized command name renders usage and returns the
 * usage exit code.
 *
 * @param context - The shared command context.
 * @param commands - The registered commands.
 * @param argv - Command-line arguments, excluding the node/script prefix.
 * @returns The exit code.
 * @example
 * ```ts
 * await dispatchCommand(context, COMMAND_REGISTRY, ["validate"]);
 * ```
 */
async function dispatchCommand(
  context: CommandContext,
  commands: CommandDefinition[],
  argv: string[]
): Promise<number> {
  const [name, ...rest] = argv;
  const command = commands.find(candidate => candidate.name === name);
  if (!command) {
    renderUsage(context, commands);
    return EXIT_CODES.usage;
  }

  const parsed = parseCommandArguments(command, rest);
  if (!parsed.ok) {
    context.ui.error(parsed.message);
    return EXIT_CODES.usage;
  }

  try {
    return await command.run(context, parsed.flags, parsed.positionals);
  } catch (error) {
    context.ui.error(`"${command.name}" failed`, error);
    return EXIT_CODES.failure;
  }
}

/**
 * Creates the cli API surface (`dispatch`/`commands`), binding the shared
 * command context and registry once.
 *
 * @param ctx - The cli plugin's domain context.
 * @returns The `app.cli` API.
 * @example
 * ```ts
 * const api = createCliApi(ctx);
 * await api.dispatch(["validate"]);
 * ```
 */
export function createCliApi(ctx: CliContext): CliApi {
  const context = buildCommandContext(ctx);

  return {
    /**
     * Parses argv, routes to a command, and returns the exit code. See {@link dispatchCommand}.
     *
     * @param argv - Command-line arguments, excluding the node/script prefix.
     * @returns The exit code.
     * @example
     * ```ts
     * await app.cli.dispatch(["validate"]);
     * ```
     */
    dispatch: argv => dispatchCommand(context, COMMAND_REGISTRY, argv),
    /**
     * The mountable command tree. See {@link toCommandTree}.
     *
     * @returns The command tree.
     * @example
     * ```ts
     * app.cli.commands();
     * ```
     */
    commands: () => toCommandTree(COMMAND_REGISTRY)
  };
}
