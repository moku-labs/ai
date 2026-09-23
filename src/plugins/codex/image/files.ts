/**
 * @file codex image files — copies refs into the per-call temp dir with an
 * extension codex understands, and finds the image codex wrote.
 */
import { copyFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ImageFile } from "../../image/contract";

/** File extension per reference MIME type; anything else is copied as png. */
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
};

/** MIME type per result file extension. */
const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

/** File name codex is asked to write. */
const OUTPUT_NAME = "output.png";

/** Prefix of copied reference files, never taken as the result. */
const REF_PREFIX = "ref-";

/**
 * File extension for a reference MIME type.
 *
 * @param mimeType - Reference MIME type.
 * @returns "png", "jpg" or "webp"; "png" for anything unknown.
 * @example
 * ```ts
 * extensionForMime("image/jpeg"); // => "jpg"
 * ```
 */
export function extensionForMime(mimeType: string): string {
  return EXTENSION_BY_MIME[mimeType] ?? "png";
}

/**
 * MIME type for a result file name, by extension.
 *
 * @param fileName - Result file name.
 * @returns The MIME type, or undefined when it is not an image extension.
 * @example
 * ```ts
 * mimeForFile("output.png"); // => "image/png"
 * ```
 */
export function mimeForFile(fileName: string): string | undefined {
  return MIME_BY_EXTENSION[path.extname(fileName).toLowerCase()];
}

/**
 * Copies each ref to `<dir>/ref-<n>.<ext>`. Store paths have no extension,
 * and codex infers the image type from it.
 *
 * @param references - Reference images from the request.
 * @param dir - Per-call temp dir.
 * @returns Absolute paths of the copies, in ref order.
 * @example
 * ```ts
 * const refPaths = await copyReferences(request.refs ?? [], dir);
 * ```
 */
export async function copyReferences(references: ImageFile[], dir: string): Promise<string[]> {
  const copies = references.map((ref, index) => ({
    from: ref.path,
    to: path.join(dir, `${REF_PREFIX}${index + 1}.${extensionForMime(ref.mimeType)}`)
  }));
  await Promise.all(copies.map(copy => copyFile(copy.from, copy.to)));
  return copies.map(copy => copy.to);
}

/**
 * Finds the image codex wrote: `output.png` when present, else the newest
 * image file that is not a copied ref.
 *
 * @param dir - Per-call temp dir.
 * @returns Absolute path of the result, or undefined when there is none.
 * @example
 * ```ts
 * const resultPath = await findResultImage(dir);
 * ```
 */
export async function findResultImage(dir: string): Promise<string | undefined> {
  const names = await readdir(dir);
  if (names.includes(OUTPUT_NAME)) return path.join(dir, OUTPUT_NAME);

  const candidates = names.filter(
    name => !name.startsWith(REF_PREFIX) && mimeForFile(name) !== undefined
  );
  const dated = await Promise.all(
    candidates.map(async name => {
      const filePath = path.join(dir, name);
      const stats = await stat(filePath);
      return { filePath, modifiedMs: stats.mtimeMs };
    })
  );
  const newest = dated.toSorted((a, b) => b.modifiedMs - a.modifiedMs)[0];
  return newest?.filePath;
}
