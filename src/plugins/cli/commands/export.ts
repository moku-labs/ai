/**
 * @file cli `export [runId] [--out <dir>] [--flat]` — copies a run's done
 * artifacts to named files (`<out>/<build>/<label>.<ext>`, or
 * `<out>/<label>.<ext>` with `--flat`), and the shared renderer the `run`
 * command reuses after a run.
 */
import type { ExportResult } from "../../runner/types";
import type { CommandContext, CommandFlags } from "../types";
import { EXIT_CODES } from "../types";

/** Export directory used when `--out` is omitted. */
export const DEFAULT_OUT_DIR = "out";

/**
 * Renders one line per exported file (`label  $cost  path`) plus skipped labels.
 *
 * @param context - The command context.
 * @param result - The export result.
 */
export function renderExport(context: CommandContext, result: ExportResult): void {
  if (result.files.length === 0) {
    context.ui.info(`no done artifacts to export for run ${result.runId}`);
    return;
  }

  const lines = result.files.map(file =>
    context.ui.railLine(`  ${file.label}`, `$${file.costUsd.toFixed(4)}  ${file.path}`)
  );
  for (const label of result.skipped) {
    lines.push(context.ui.railLine(`  ${label}`, "skipped: unsafe name or duplicate target"));
  }
  context.ui.box(lines);
}

/**
 * `moku export [runId] [--out <dir>] [--flat]`: exports the given (or newest) run.
 *
 * @param context - The command context.
 * @param flags - Parsed flags (`out`, `flat`).
 * @param positionals - Optional run id.
 * @returns `0` on success, `1` when the run does not exist.
 */
export async function runExportCommand(
  context: CommandContext,
  flags: CommandFlags,
  positionals: string[]
): Promise<number> {
  const runId = positionals[0];
  const outputDirectory = flags.out ?? DEFAULT_OUT_DIR;
  const flat = flags.flat === "true";

  try {
    const result = await context.runner.export(
      runId === undefined
        ? { outDir: outputDirectory, flat }
        : { runId, outDir: outputDirectory, flat }
    );
    renderExport(context, result);
    return EXIT_CODES.ok;
  } catch (error) {
    context.ui.error("export failed", error);
    return EXIT_CODES.failure;
  }
}
