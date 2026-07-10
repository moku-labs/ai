/**
 * @file `moku compose "<prompt>" [--emit build|script] [--out <path>]` — compose command.
 */
import { writeFile } from "node:fs/promises";
import type { CommandContext, CommandFlags } from "../types";
import { EXIT_CODES } from "../types";

/** Substring of compose's pinned "repair attempts exhausted" error message. */
const REPAIR_EXHAUSTED_MARKER = "could not produce a valid build file";

/**
 * Whether `error` is compose's "repair attempts exhausted" failure (an
 * invalid build file even after every repair attempt), as opposed to a
 * generic runtime failure.
 *
 * @param error - The caught error.
 * @returns True when `error` is the repair-exhausted failure.
 * @example
 * ```ts
 * isRepairExhaustedError(error); // true after maxRepairAttempts is exceeded
 * ```
 */
function isRepairExhaustedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(REPAIR_EXHAUSTED_MARKER);
}

/**
 * Narrows a raw `--emit` flag value to compose's accepted emit format.
 *
 * @param value - The raw flag value.
 * @returns True when `value` is `"build"` or `"script"`.
 * @example
 * ```ts
 * isEmitFormat("build"); // true
 * ```
 */
function isEmitFormat(value: string): value is "build" | "script" {
  return value === "build" || value === "script";
}

/**
 * Writes the emitted build-file text to `outPath`, or prints it to stdout
 * when no `--out` was given.
 *
 * @param context - CommandContext (branded console + required plugin APIs).
 * @param outPath - The `--out` flag value, if given.
 * @param text - The emitted build-file text.
 * @example
 * ```ts
 * await writeComposeResult(context, "demo.moku.yaml", text);
 * ```
 */
async function writeComposeResult(
  context: CommandContext,
  outPath: string | undefined,
  text: string
): Promise<void> {
  if (outPath === undefined) {
    context.ui.line(text);
    return;
  }
  await writeFile(outPath, text, "utf8");
  context.ui.check(true, `wrote ${outPath}`);
}

/**
 * Runs the `compose` command: `compose.compose` → writes the emitted text
 * (or prints it to stdout). Wires SIGINT to an abort signal so a clean pause
 * is possible mid-generation.
 *
 * @param context - CommandContext (branded console + required plugin APIs).
 * @param flags - Parsed command flags (`emit`, `out`).
 * @param positionals - Positional args; `positionals[0]` is the natural-language prompt.
 * @returns `EXIT_CODES.ok` on success, `EXIT_CODES.usage` for a missing prompt/bad `--emit`,
 *   `EXIT_CODES.validation` when every repair attempt failed, else `EXIT_CODES.failure`.
 * @example
 * ```ts
 * const code = await runComposeCommand(context, { emit: "build" }, ["narrate a sunset"]);
 * ```
 */
export async function runComposeCommand(
  context: CommandContext,
  flags: CommandFlags,
  positionals: string[]
): Promise<number> {
  const prompt = positionals[0];
  if (prompt === undefined) {
    context.ui.error('moku compose requires a "<prompt>" argument');
    return EXIT_CODES.usage;
  }

  const emit = flags.emit ?? "build";
  if (!isEmitFormat(emit)) {
    context.ui.error(`invalid --emit value "${emit}" (expected "build" or "script")`);
    return EXIT_CODES.usage;
  }

  try {
    const result = await context.runWithAbort(signal =>
      context.compose.compose({ prompt, emit, signal })
    );
    await writeComposeResult(context, flags.out, result.text);
    context.ui.info(`cost: $${result.costUsd.toFixed(4)}`);
    return EXIT_CODES.ok;
  } catch (error) {
    context.ui.error("compose failed", error);
    return isRepairExhaustedError(error) ? EXIT_CODES.validation : EXIT_CODES.failure;
  }
}
