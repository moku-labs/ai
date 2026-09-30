/**
 * @file runner resolve — the data edges of one item: `$ref`/`$file` values
 * turned into local files for the handler, mime ⇄ extension tables, image
 * signatures read from a file's first bytes, and the normalization of a
 * handler result into bytes + mime type (D1, D9, D10).
 */
import path from "node:path";
import { isFileValue, isReferenceValue } from "../buildfile";
import type { FileMimeType, HandlerResult, ResolvedFile } from "./types";

/** Fallback mime type for bytes of unknown kind. */
export const OCTET_STREAM = "application/octet-stream";

/** Mime type recorded for `text` results. */
const TEXT_MIME = "text/plain; charset=utf-8";

/** Mime type by lowercase file extension, for `$file` inputs. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  json: "application/json",
  txt: "text/plain"
};

/** Bytes an image signature expects, starting at `offset`. */
type SignaturePart = { offset: number; bytes: readonly number[] };

/** An image format recognized from its first bytes: every part must match. */
type ImageSignature = { mimeType: string; parts: readonly SignaturePart[] };

/** Image formats by their magic bytes. WEBP is `RIFF` at byte 0 and `WEBP` at byte 8. */
const IMAGE_SIGNATURES: readonly ImageSignature[] = [
  { mimeType: "image/png", parts: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47] }] },
  { mimeType: "image/jpeg", parts: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }] },
  { mimeType: "image/gif", parts: [{ offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }] },
  {
    mimeType: "image/webp",
    parts: [
      { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
      { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }
    ]
  }
];

/** File extension by mime type (parameters stripped), for export. */
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "text/plain": "txt",
  "application/json": "json",
  // Asset records (the `asset` plugin's MIME) export as `<label>.json`.
  "application/vnd.moku.asset+json": "json"
};

/**
 * Mime type of a local file, from its extension.
 *
 * @param filePath - Any file path.
 * @returns The mime type, or `application/octet-stream`.
 * @example
 * ```ts
 * mimeTypeOfPath("refs/akari.png"); // => "image/png"
 * ```
 */
export function mimeTypeOfPath(filePath: string): string {
  return MIME_BY_EXTENSION[extensionOfPath(filePath)] ?? OCTET_STREAM;
}

/**
 * Lowercase extension of a path, without the dot.
 *
 * @param filePath - Any file path.
 * @returns The extension, or an empty string when there is none.
 * @example
 * ```ts
 * extensionOfPath("refs/akari.PNG"); // => "png"
 * ```
 */
function extensionOfPath(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase();
}

/**
 * Whether `bytes` hold a signature part at its offset.
 *
 * @param bytes - The file's bytes.
 * @param part - The expected bytes and where they start.
 * @returns True when every expected byte is there.
 * @example
 * ```ts
 * hasPart(new Uint8Array([0xff, 0xd8, 0xff]), { offset: 0, bytes: [0xff, 0xd8, 0xff] }); // => true
 * ```
 */
function hasPart(bytes: Uint8Array, part: SignaturePart): boolean {
  return part.bytes.every((expected, index) => bytes[part.offset + index] === expected);
}

/**
 * Image mime type from a file's first bytes: PNG, JPEG, GIF or WEBP.
 *
 * @param bytes - The file's bytes (only the first twelve are read).
 * @returns The image mime type, or undefined when no image signature matches.
 * @example
 * ```ts
 * imageMimeTypeOfBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])); // => "image/jpeg"
 * imageMimeTypeOfBytes(new TextEncoder().encode("hello")); // => undefined
 * ```
 */
export function imageMimeTypeOfBytes(bytes: Uint8Array): string | undefined {
  const signature = IMAGE_SIGNATURES.find(candidate =>
    candidate.parts.every(part => hasPart(bytes, part))
  );
  return signature?.mimeType;
}

/**
 * Mime type of a local file from its path and the bytes already read: an
 * image signature wins over the extension, and a disagreement is named in
 * `mismatch`. A file with no image signature keeps the extension map.
 *
 * @param filePath - The file's path.
 * @param bytes - The file's bytes.
 * @returns The mime type, and the mismatch when the signature and the extension disagree.
 * @example
 * ```ts
 * mimeTypeOfFile("refs/akari.png", jpegBytes);
 * // => { mimeType: "image/jpeg", mismatch: { extension: "png", detected: "image/jpeg" } }
 * ```
 */
export function mimeTypeOfFile(filePath: string, bytes: Uint8Array): FileMimeType {
  const byExtension = mimeTypeOfPath(filePath);
  const detected = imageMimeTypeOfBytes(bytes);
  if (detected === undefined || detected === byExtension) return { mimeType: byExtension };

  return { mimeType: detected, mismatch: { extension: extensionOfPath(filePath), detected } };
}

/**
 * File extension for a mime type, for export file names.
 *
 * @param mimeType - A mime type, parameters allowed (`text/plain; charset=utf-8`).
 * @returns The extension without a dot, or `bin`.
 * @example
 * ```ts
 * extensionOfMimeType("video/mp4"); // => "mp4"
 * ```
 */
export function extensionOfMimeType(mimeType: string | null): string {
  if (mimeType === null) return "bin";
  const bare = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return EXTENSION_BY_MIME[bare] ?? "bin";
}

/**
 * Replaces every `{ $ref: id }` and `{ $file: path }` inside a request with
 * the matching {@link ResolvedFile}; everything else is copied as is.
 *
 * @param value - The flat request, or any nested part of it.
 * @param refFiles - Resolved files by `$ref` target id.
 * @param files - Resolved files by `$file` path as written.
 * @returns The request with references resolved.
 * @throws {Error} When a reference has no resolved file (a planning bug).
 * @example
 * ```ts
 * const request = resolveReferences(plan.request, refFiles, plan.files);
 * ```
 */
export function resolveReferences(
  value: unknown,
  refFiles: ReadonlyMap<string, ResolvedFile>,
  files: ReadonlyMap<string, ResolvedFile>
): unknown {
  if (isReferenceValue(value)) return requireResolved(refFiles, String(value.$ref), "$ref");
  if (isFileValue(value)) return requireResolved(files, String(value.$file), "$file");
  if (Array.isArray(value)) return value.map(entry => resolveReferences(entry, refFiles, files));
  if (typeof value === "object" && value !== null && !(value instanceof Uint8Array)) {
    const resolved: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      resolved[key] = resolveReferences(entry, refFiles, files);
    }
    return resolved;
  }
  return value;
}

/**
 * Looks up one resolved reference, throwing when it is missing.
 *
 * @param table - Resolved files by key.
 * @param key - The `$ref` id or `$file` path.
 * @param kind - Which reference kind, for the message.
 * @returns The resolved file.
 * @throws {Error} When `key` is not in `table`.
 * @example
 * ```ts
 * requireResolved(files, "refs/a.png", "$file");
 * ```
 */
function requireResolved(
  table: ReadonlyMap<string, ResolvedFile>,
  key: string,
  kind: "$ref" | "$file"
): ResolvedFile {
  const resolved = table.get(key);
  if (!resolved) {
    throw new Error(
      `[ai] Unresolved ${kind} "${key}".\n  The runner plans every reference before execution; this is a runner bug.`
    );
  }
  return resolved;
}

/**
 * Turns a handler result into the bytes to store and their mime type:
 * `body`, `audio`, `image` or `video` bytes, else UTF-8 `text`.
 *
 * @param result - What the handler returned.
 * @returns The artifact bytes and mime type.
 * @throws {Error} When the result carries neither bytes nor text (terminal, class `unknown`).
 * @example
 * ```ts
 * const { bytes, mimeType } = normalizeResult({ audio, mimeType: "audio/mpeg", costUsd: 0.01 });
 * ```
 */
export function normalizeResult(result: HandlerResult): { bytes: Uint8Array; mimeType: string } {
  const bytes = result.body ?? result.audio ?? result.image ?? result.video;
  if (bytes) return { bytes, mimeType: result.mimeType ?? OCTET_STREAM };

  if (typeof result.text === "string") {
    return { bytes: new TextEncoder().encode(result.text), mimeType: result.mimeType ?? TEXT_MIME };
  }

  throw new Error(
    "[ai] Handler result has no content.\n  Return body, audio, image, video or text from execute()/poll()."
  );
}
