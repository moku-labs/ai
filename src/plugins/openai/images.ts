/**
 * @file openai images — local image files as base64 data URLs, the form the
 * Responses API takes in an `input_image` part.
 */
import { readFile } from "node:fs/promises";
import type { OpenaiLocalImage } from "./types";

/**
 * Reads local image files as base64 data URLs, in order. A file that cannot
 * be read fails the call with the file system's error.
 *
 * @param images - The files: path and MIME type.
 * @returns One `data:<mimeType>;base64,<bytes>` URL per file.
 * @example
 * ```ts
 * await readImageDataUrls([{ path: "frames/s3-012.png", mimeType: "image/png", hash: "9f2c1a" }]);
 * // => ["data:image/png;base64,iVBORw0KGgo…"]
 * ```
 */
export function readImageDataUrls(images: readonly OpenaiLocalImage[]): Promise<string[]> {
  return Promise.all(
    images.map(async image => {
      const bytes = await readFile(image.path);
      return `data:${image.mimeType};base64,${bytes.toString("base64")}`;
    })
  );
}
