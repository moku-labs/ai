/**
 * @file anthropic images — the checked image files of a request (local
 * files of a type the Messages API reads) and their base64 image blocks,
 * read from disk.
 */
import { readFile } from "node:fs/promises";
import { badRequest } from "./client";
import type { AnthropicImageBlock, AnthropicImageMediaType } from "./types";

/**
 * A local image file of a type the Messages API reads.
 *
 * @example
 * ```ts
 * const file: ImageFile = { path: "frames/s3-012.png", mimeType: "image/png", hash: "9f2c1a" };
 * ```
 */
export type ImageFile = {
  /** Path of the file on disk. */
  path: string;
  /** Its image type. */
  mimeType: AnthropicImageMediaType;
  /** Content hash, as the request carries it. */
  hash: string;
};

/** Image types the Messages API reads. */
const MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp"
]);

/**
 * Reads a string property off an untrusted value.
 *
 * @param value - Any value.
 * @param key - Property name.
 * @returns The string, or undefined.
 * @example
 * ```ts
 * stringField({ path: "a.png" }, "path"); // => "a.png"
 * ```
 */
function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
}

/**
 * Whether a MIME type is one the Messages API reads.
 *
 * @param mimeType - Any MIME type.
 * @returns True for jpeg, png, gif and webp.
 * @example
 * ```ts
 * isMediaType("image/bmp"); // => false
 * ```
 */
function isMediaType(mimeType: string): mimeType is AnthropicImageMediaType {
  return MEDIA_TYPES.has(mimeType);
}

/**
 * Checks one image of a request: a local file `{ path, mimeType, hash }`
 * of a type the Messages API reads.
 *
 * @param value - A `params.images` entry or an image part, untrusted.
 * @returns The checked file.
 * @throws {TerminalProviderError} A 400 for a value that is not a local file, or an image type the API cannot read.
 * @example
 * ```ts
 * imageFileOf({ path: "a.png", mimeType: "image/png", hash: "h" }); // => { path: "a.png", mimeType: "image/png", hash: "h" }
 * ```
 */
export function imageFileOf(value: unknown): ImageFile {
  const path = stringField(value, "path");
  const mimeType = stringField(value, "mimeType");
  const hash = stringField(value, "hash");
  if (path === undefined || mimeType === undefined || hash === undefined) {
    throw badRequest(
      "[ai] Anthropic params.images must be local files.\n  Pass { path, mimeType, hash } for every image."
    );
  }
  if (!isMediaType(mimeType)) {
    throw badRequest(
      `[ai] Anthropic cannot read image type ${mimeType}.\n  Send image/jpeg, image/png, image/gif or image/webp.`
    );
  }
  return { path, mimeType, hash };
}

/**
 * Reads image files into base64 image blocks, in order.
 *
 * @param files - The checked image files.
 * @param signal - Caller abort signal; cancels the reads.
 * @returns One image block per file.
 */
export async function readImageBlocks(
  files: readonly ImageFile[],
  signal: AbortSignal | undefined
): Promise<AnthropicImageBlock[]> {
  const options = signal === undefined ? {} : { signal };
  return Promise.all(
    files.map(async (file): Promise<AnthropicImageBlock> => {
      const bytes = await readFile(file.path, options);
      const data = bytes.toString("base64");
      return { type: "image", source: { type: "base64", media_type: file.mimeType, data } };
    })
  );
}
