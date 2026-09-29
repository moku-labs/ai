/**
 * @file claude image files — copies `params.images` into the per-call temp
 * dir with an extension, so claude's Read tool sees them as images.
 */
import { copyFile } from "node:fs/promises";
import path from "node:path";
import type { ImageFile } from "../../image/contract";

/** File extension per image MIME type; anything else is copied as png (the codex rule). */
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
};

/**
 * File extension for an image MIME type.
 *
 * @param mimeType - Image MIME type.
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
 * Copies each image to `<dir>/image-<n>.<ext>`. Store paths have no
 * extension, and the Read tool needs one to treat a file as an image.
 *
 * @param images - Images from `params.images`.
 * @param dir - Per-call temp dir.
 * @returns File names of the copies (relative to `dir`), in image order.
 * @example
 * ```ts
 * await copyImages([{ path: "/store/ab12", mimeType: "image/png", hash: "h" }], "/tmp/moku-claude-x"); // => ["image-1.png"]
 * ```
 */
export async function copyImages(images: ImageFile[], dir: string): Promise<string[]> {
  const names = images.map(
    (image, index) => `image-${index + 1}.${extensionForMime(image.mimeType)}`
  );
  await Promise.all(
    images.map((image, index) => copyFile(image.path, path.join(dir, names[index] ?? "")))
  );
  return names;
}
