/**
 * @file runner export — copies a run's `done` artifacts out of the
 * content-addressed store to named files: `<outDir>/<build>/<label>.<ext>` (D9),
 * or `<outDir>/<label>.<ext>` with `flat`, and `<label>-<k>.<ext>` for output
 * k ≥ 2 of a multi-output item.
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
 * The file an entry is written to: `<buildDirectory>/<label>.<ext>`, the extension from its mime type.
 *
 * @param entry - What to write.
 * @param buildDirectory - Absolute folder of the item's files: its build folder, or the export root with `flat`.
 * @returns The absolute target path.
 * @example
 * ```ts
 * targetOf({ label: "x-2", contentHash: "h", mimeType: "image/png", costUsd: 0 }, "/repo/out/b"); // => "/repo/out/b/x-2.png"
 * ```
 */
function targetOf(entry: ExportEntry, buildDirectory: string): string {
  return path.join(buildDirectory, `${entry.label}.${extensionOfMimeType(entry.mimeType)}`);
}

/**
 * Copies one stored artifact to its target file.
 *
 * @param ctx - Runner domain context.
 * @param entry - What to write.
 * @param target - Absolute target path, from {@link targetOf}.
 * @returns The written file.
 */
async function exportEntry(
  ctx: RunnerContext,
  entry: ExportEntry,
  target: string
): Promise<ExportedFile> {
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(ctx.store.pathOf(entry.contentHash), target);

  const { size } = await stat(target);
  const mimeType = entry.mimeType ?? "application/octet-stream";
  return { label: entry.label, path: target, bytes: size, costUsd: entry.costUsd, mimeType };
}

/**
 * The folder an item's files go to: `<outputDirectory>/<build>`, or the
 * export directory itself when `flat`.
 *
 * @param outputDirectory - Absolute export directory.
 * @param buildName - The item's build name.
 * @param flat - Whether to skip the build folder.
 * @returns The absolute folder, or undefined when the build name is unsafe as a folder name.
 * @example
 * ```ts
 * itemDirectoryOf("/repo/out", "ep01", false); // => "/repo/out/ep01"
 * itemDirectoryOf("/repo/out", "ep01", true); // => "/repo/out"
 * ```
 */
function itemDirectoryOf(
  outputDirectory: string,
  buildName: string,
  flat: boolean
): string | undefined {
  if (flat) return outputDirectory;
  if (!isSafeRelativeName(buildName)) return undefined;
  return path.join(outputDirectory, buildName);
}

/** Where and how one export writes: its absolute folder and whether build folders are skipped. */
type ExportTarget = { outputDirectory: string; flat: boolean };

/**
 * Copies one done item's artifacts to their named files: one file, or one
 * per output of a multi-output item.
 *
 * @param ctx - Runner domain context.
 * @param item - A `done` item with a content hash.
 * @param target - Absolute export directory and the `flat` switch.
 * @param taken - Target paths already written by this export; the item's targets are added.
 * @returns The written files, or undefined when the item's names are unsafe or one of its
 *   files would overwrite a file this export already wrote (a group's `x-2` next to an item
 *   `x-2`, or with `flat` the same label in two builds).
 */
async function exportItem(
  ctx: RunnerContext,
  item: ItemRow & { contentHash: string },
  target: ExportTarget,
  taken: Set<string>
): Promise<ExportedFile[] | undefined> {
  const label = item.label ?? item.id;
  const buildName = item.buildName ?? UNNAMED_BUILD;
  const itemDirectory = itemDirectoryOf(target.outputDirectory, buildName, target.flat);
  if (itemDirectory === undefined || !isSafeRelativeName(label)) return undefined;

  // Never overwrite a file this export already wrote.
  const writes = exportEntriesOf(item, label).map(entry => ({
    entry,
    target: targetOf(entry, itemDirectory)
  }));
  if (writes.some(write => taken.has(write.target))) return undefined;
  for (const write of writes) taken.add(write.target);

  // One file per output, in order, so `<label>-2` never lands before `<label>`.
  const files: ExportedFile[] = [];
  for (const write of writes) files.push(await exportEntry(ctx, write.entry, write.target));
  return files;
}

/**
 * Copies every `done` artifact of a run to `<outDir>/<build>/<label>.<ext>`,
 * or to `<outDir>/<label>.<ext>` with `flat`, the extension coming from the
 * stored mime type. A multi-output item adds `<label>-2.<ext>` …
 * `<label>-N.<ext>`. Files from earlier exports are overwritten. Labels that
 * would escape `outDir`, and items whose file this export already wrote, are
 * skipped and listed.
 *
 * @param ctx - Runner domain context.
 * @param opts - Optional run id (default: the newest run), output directory (default "out") and `flat`.
 * @param opts.runId - Run to export.
 * @param opts.outDir - Export root, relative to the working directory or absolute.
 * @param opts.flat - Write into `outDir` directly, without the `<build>/` folder. Default false.
 * @returns The files written and the labels skipped.
 * @throws {Error} When the run does not exist.
 */
export async function exportRun(
  ctx: RunnerContext,
  opts?: { runId?: string; outDir?: string; flat?: boolean }
): Promise<ExportResult> {
  // The run to export and where its files go.
  const run = pickRun(ctx, opts?.runId);
  const outputDirectory = path.resolve(opts?.outDir ?? DEFAULT_OUT_DIR);
  const target: ExportTarget = { outputDirectory, flat: opts?.flat ?? false };

  // Export each done item; an item that cannot be written is listed as skipped.
  const files: ExportedFile[] = [];
  const skipped: string[] = [];
  const taken = new Set<string>();

  for (const item of ctx.journal.listItems(run.id, { status: "done" })) {
    if (item.contentHash === null) continue;
    const doneItem = { ...item, contentHash: item.contentHash };
    const written = await exportItem(ctx, doneItem, target, taken);
    if (written) files.push(...written);
    else skipped.push(item.label ?? item.id);
  }

  return { runId: run.id, outDir: outputDirectory, files, skipped };
}
