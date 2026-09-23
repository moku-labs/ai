/**
 * @file runner export — copies a run's `done` artifacts out of the
 * content-addressed store to named files: `<outDir>/<build>/<label>.<ext>` (D9).
 */
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ItemRow, RunRow } from "../journal/types";
import { extensionOfMimeType } from "./resolve";
import type { ExportedFile, ExportResult, RunnerContext } from "./types";

/** Default export directory. */
const DEFAULT_OUT_DIR = "out";

/** Folder used for items written before build names were journaled. */
const UNNAMED_BUILD = "build";

/**
 * Whether a label or build name is safe to use as a relative path: no
 * absolute path, no `..` segment, not empty.
 *
 * @param name - A label or build name.
 * @returns True when it stays inside the export directory.
 * @example
 * ```ts
 * isSafeRelativeName("ep01/shot03"); // => true
 * isSafeRelativeName("../etc"); // => false
 * ```
 */
function isSafeRelativeName(name: string): boolean {
  if (name.length === 0 || path.isAbsolute(name)) return false;
  return !name.split(/[/\\]/).includes("..");
}

/**
 * Picks the run to export: the given id, else the newest run.
 *
 * @param ctx - Runner domain context.
 * @param runId - Optional run id.
 * @returns The run row.
 * @throws {Error} When the run does not exist, or the journal has no runs.
 * @example
 * ```ts
 * const run = pickRun(ctx, undefined);
 * ```
 */
function pickRun(ctx: RunnerContext, runId: string | undefined): RunRow {
  const run = runId === undefined ? ctx.journal.latestRun() : ctx.journal.getRun(runId);
  if (!run) {
    throw new Error(
      runId === undefined
        ? "[ai] No run to export.\n  Run a build first."
        : `[ai] Run not found: ${runId}.\n  Verify the run id came from a previous run() or resume() call.`
    );
  }
  return run;
}

/**
 * Copies one done item's artifact to its named file.
 *
 * @param ctx - Runner domain context.
 * @param item - A `done` item with a content hash.
 * @param outputDirectory - Absolute export directory.
 * @returns The written file, or undefined when its name is unsafe.
 * @example
 * ```ts
 * const file = await exportItem(ctx, item, "/repo/out");
 * ```
 */
async function exportItem(
  ctx: RunnerContext,
  item: ItemRow & { contentHash: string },
  outputDirectory: string
): Promise<ExportedFile | undefined> {
  const label = item.label ?? item.id;
  const buildName = item.buildName ?? UNNAMED_BUILD;
  if (!isSafeRelativeName(label) || !isSafeRelativeName(buildName)) return undefined;

  const mimeType = item.mimeType ?? "application/octet-stream";
  const fileName = `${label}.${extensionOfMimeType(item.mimeType)}`;
  const target = path.join(outputDirectory, buildName, fileName);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(ctx.store.pathOf(item.contentHash), target);

  const { size } = await stat(target);
  return { label, path: target, bytes: size, costUsd: item.actualCostUsd ?? 0, mimeType };
}

/**
 * Copies every `done` artifact of a run to `<outDir>/<build>/<label>.<ext>`,
 * the extension coming from the stored mime type. Existing files are
 * overwritten. Labels that would escape `outDir` are skipped and listed.
 *
 * @param ctx - Runner domain context.
 * @param opts - Optional run id (default: the newest run) and output directory (default "out").
 * @param opts.runId - Run to export.
 * @param opts.outDir - Export root, relative to the working directory or absolute.
 * @returns The files written and the labels skipped.
 * @throws {Error} When the run does not exist.
 * @example
 * ```ts
 * const result = await exportRun(ctx, { outDir: "out" });
 * ```
 */
export async function exportRun(
  ctx: RunnerContext,
  opts?: { runId?: string; outDir?: string }
): Promise<ExportResult> {
  const run = pickRun(ctx, opts?.runId);
  const outputDirectory = path.resolve(opts?.outDir ?? DEFAULT_OUT_DIR);
  const files: ExportedFile[] = [];
  const skipped: string[] = [];

  for (const item of ctx.journal.listItems(run.id, { status: "done" })) {
    if (item.contentHash === null) continue;
    const doneItem = { ...item, contentHash: item.contentHash };
    const file = await exportItem(ctx, doneItem, outputDirectory);
    if (file) files.push(file);
    else skipped.push(item.label ?? item.id);
  }

  return { runId: run.id, outDir: outputDirectory, files, skipped };
}
