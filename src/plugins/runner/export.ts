/**
 * @file runner export — copies a run's `done` artifacts out of the
 * content-addressed store to named files: `<outDir>/<build>/<label>.<ext>` (D9),
 * and `<label>-<k>.<ext>` for output k ≥ 2 of a multi-output item.
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

/** One file to write for a done item: its label, stored bytes, mime type and the cost it carries. */
type ExportEntry = {
  label: string;
  contentHash: string;
  mimeType: string | null;
  costUsd: number;
};

/**
 * The files a done item exports to: one for a single artifact; one per
 * output for a multi-output item, `<label>` then `<label>-2` … `<label>-N`.
 * The item cost is on the first file and 0 on the others, so the sum stays right.
 *
 * @param item - A `done` item with a content hash.
 * @param label - The item's export label.
 * @returns The entries, in output order.
 * @example
 * ```ts
 * exportEntriesOf({ ...item, outputs: [first, second] }, "x").map(entry => entry.label); // => ["x", "x-2"]
 * ```
 */
function exportEntriesOf(item: ItemRow & { contentHash: string }, label: string): ExportEntry[] {
  const costUsd = item.actualCostUsd ?? 0;
  if (item.outputs === null) {
    return [{ label, contentHash: item.contentHash, mimeType: item.mimeType, costUsd }];
  }

  return item.outputs.map((output, index) => ({
    label: index === 0 ? label : `${label}-${index + 1}`,
    contentHash: output.contentHash,
    mimeType: output.mimeType,
    costUsd: index === 0 ? costUsd : 0
  }));
}

/**
 * Copies one stored artifact to `<buildDirectory>/<label>.<ext>`, the extension from its mime type.
 *
 * @param ctx - Runner domain context.
 * @param entry - What to write.
 * @param buildDirectory - Absolute folder of the item's build.
 * @returns The written file.
 */
async function exportEntry(
  ctx: RunnerContext,
  entry: ExportEntry,
  buildDirectory: string
): Promise<ExportedFile> {
  const target = path.join(buildDirectory, `${entry.label}.${extensionOfMimeType(entry.mimeType)}`);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(ctx.store.pathOf(entry.contentHash), target);

  const { size } = await stat(target);
  const mimeType = entry.mimeType ?? "application/octet-stream";
  return { label: entry.label, path: target, bytes: size, costUsd: entry.costUsd, mimeType };
}

/**
 * Copies one done item's artifacts to their named files: one file, or one
 * per output of a multi-output item.
 *
 * @param ctx - Runner domain context.
 * @param item - A `done` item with a content hash.
 * @param outputDirectory - Absolute export directory.
 * @returns The written files, or undefined when the item's names are unsafe.
 */
async function exportItem(
  ctx: RunnerContext,
  item: ItemRow & { contentHash: string },
  outputDirectory: string
): Promise<ExportedFile[] | undefined> {
  const label = item.label ?? item.id;
  const buildName = item.buildName ?? UNNAMED_BUILD;
  if (!isSafeRelativeName(label) || !isSafeRelativeName(buildName)) return undefined;

  // One file per output, in order, so `<label>-2` never lands before `<label>`.
  const buildDirectory = path.join(outputDirectory, buildName);
  const files: ExportedFile[] = [];
  for (const entry of exportEntriesOf(item, label)) {
    files.push(await exportEntry(ctx, entry, buildDirectory));
  }
  return files;
}

/**
 * Copies every `done` artifact of a run to `<outDir>/<build>/<label>.<ext>`,
 * the extension coming from the stored mime type. A multi-output item adds
 * `<label>-2.<ext>` … `<label>-N.<ext>`. Existing files are
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
    const written = await exportItem(ctx, doneItem, outputDirectory);
    if (written) files.push(...written);
    else skipped.push(item.label ?? item.id);
  }

  return { runId: run.id, outDir: outputDirectory, files, skipped };
}
