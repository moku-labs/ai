/**
 * @file fal input upload — turns local `VideoFile`s into URLs fal can read.
 * `"storage"` mode initiates a fal storage upload, PUTs the bytes to the
 * presigned URL and sends the returned file URL. When the initiate call
 * fails, the rest of that request falls back to base64 data URIs (logged once
 * as `fal:upload:fallback`). `"data-uri"` mode always inlines.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { VideoFile } from "../video/contract";
import { falFetch, parseJson, readString } from "./client";
import type { UploadedUrls } from "./models";
import type { FalContext, UploadMode } from "./types";
import { RetryableProviderError, TerminalProviderError } from "./types";

/**
 * Per-call upload options.
 *
 * @example
 * ```ts
 * const options: UploadOptions = { apiKey, signal: controller.signal };
 * ```
 */
export type UploadOptions = {
  /** fal key for the storage initiate call. */
  apiKey: string;
  /** Caller abort signal. */
  signal?: AbortSignal | undefined;
};

/**
 * Where one file goes in fal storage.
 *
 * @example
 * ```ts
 * const target: StorageTarget = { uploadUrl: "https://upload/put", fileUrl: "https://cdn/file" };
 * ```
 */
type StorageTarget = {
  /** Presigned PUT URL. */
  uploadUrl: string;
  /** Public file URL sent to the model. */
  fileUrl: string;
};

/**
 * Mutable mode of one upload call: starts at `config.upload` and drops to
 * `"data-uri"` after an initiate failure.
 *
 * @example
 * ```ts
 * const session: UploadSession = { mode: "storage" };
 * ```
 */
type UploadSession = { mode: UploadMode };

/** File extensions by MIME type, for the storage file name. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg"
};

/**
 * Storage file name: the first 16 hash characters plus an extension from
 * the MIME type, else from the path, else `bin`.
 *
 * @param file - The input file.
 * @returns File name, e.g. `"abcd1234abcd1234.png"`.
 * @example
 * ```ts
 * fileNameOf({ path: "/a/b.png", mimeType: "image/png", hash: "abcd..." }); // => "abcd1234abcd1234.png"
 * ```
 */
export function fileNameOf(file: VideoFile): string {
  const fromPath = path.extname(file.path).slice(1).toLowerCase();
  const extension = EXTENSIONS[file.mimeType] ?? (fromPath === "" ? "bin" : fromPath);
  return `${file.hash.slice(0, 16)}.${extension}`;
}

/**
 * Inlines bytes as a base64 data URI.
 *
 * @param bytes - File bytes.
 * @param mimeType - File MIME type.
 * @returns `data:<mime>;base64,<...>`.
 * @example
 * ```ts
 * toDataUri(new Uint8Array([1]), "image/png"); // => "data:image/png;base64,AQ=="
 * ```
 */
export function toDataUri(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * Reads an input file's bytes.
 *
 * @param file - The input file.
 * @returns The bytes.
 * @throws {Error} A plain (terminal) error when the file cannot be read.
 * @example
 * ```ts
 * const bytes = await readInput(file);
 * ```
 */
async function readInput(file: VideoFile): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(file.path));
  } catch {
    throw new Error(
      `[ai] Cannot read fal input file "${file.path}".\n  Check that the $ref or $file it came from still exists.`
    );
  }
}

/**
 * HTTP status carried by a classified error, for the fallback log.
 *
 * @param error - What the initiate call threw.
 * @returns The status, or undefined for a network/timeout/parse failure.
 * @example
 * ```ts
 * statusOf(new TerminalProviderError("x", 401)); // => 401
 * ```
 */
function statusOf(error: unknown): number | undefined {
  const hasStatus =
    error instanceof RetryableProviderError || error instanceof TerminalProviderError;
  return hasStatus ? error.status : undefined;
}

/**
 * Asks fal storage where to PUT one file.
 *
 * @param ctx - Plugin context (`config.uploadUrl`, `config.timeoutMs`).
 * @param file - The input file.
 * @param options - Key and caller signal.
 * @returns The presigned PUT URL and the public file URL.
 * @throws {Error} Any failure (the caller decides whether to fall back).
 * @example
 * ```ts
 * const target = await initiate(ctx, file, options);
 * ```
 */
async function initiate(
  ctx: FalContext,
  file: VideoFile,
  options: UploadOptions
): Promise<StorageTarget> {
  const response = await falFetch({
    url: ctx.config.uploadUrl,
    method: "POST",
    apiKey: options.apiKey,
    json: { file_name: fileNameOf(file), content_type: file.mimeType },
    timeoutMs: ctx.config.timeoutMs,
    signal: options.signal
  });
  const body = parseJson(response, "upload response");
  const uploadUrl = readString(body, "upload_url");
  const fileUrl = readString(body, "file_url");
  if (uploadUrl === undefined || fileUrl === undefined) {
    throw new Error(
      "[ai] fal returned an incomplete upload response.\n  Expected upload_url and file_url."
    );
  }
  return { uploadUrl, fileUrl };
}

/**
 * Uploads one file to fal storage. Returns undefined, after logging
 * `fal:upload:fallback`, when the initiate call fails; a caller abort is
 * rethrown. A failed PUT throws its classified error.
 *
 * @param ctx - Plugin context.
 * @param file - The input file.
 * @param bytes - The file bytes.
 * @param options - Key and caller signal.
 * @returns The public file URL, or undefined to fall back to a data URI.
 * @example
 * ```ts
 * const url = await uploadToStorage(ctx, file, bytes, options);
 * ```
 */
async function uploadToStorage(
  ctx: FalContext,
  file: VideoFile,
  bytes: Uint8Array,
  options: UploadOptions
): Promise<string | undefined> {
  let target: StorageTarget;
  try {
    target = await initiate(ctx, file, options);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    ctx.log.warn("fal:upload:fallback", { status: statusOf(error) });
    return undefined;
  }

  try {
    await falFetch({
      url: target.uploadUrl,
      method: "PUT",
      bytes,
      contentType: file.mimeType,
      timeoutMs: ctx.config.timeoutMs,
      signal: options.signal
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    ctx.log.warn("fal:upload:fallback", { status: statusOf(error) });
    return undefined;
  }
  return target.fileUrl;
}

/**
 * Makes one file readable by fal, in the session's current mode.
 *
 * @param ctx - Plugin context.
 * @param session - The call's upload mode (downgraded on initiate failure).
 * @param file - The input file.
 * @param options - Key and caller signal.
 * @returns A file URL or a data URI.
 * @example
 * ```ts
 * const url = await uploadOne(ctx, session, file, options);
 * ```
 */
async function uploadOne(
  ctx: FalContext,
  session: UploadSession,
  file: VideoFile,
  options: UploadOptions
): Promise<string> {
  const bytes = await readInput(file);
  if (session.mode === "storage") {
    const url = await uploadToStorage(ctx, file, bytes, options);
    if (url !== undefined) return url;
    session.mode = "data-uri";
  }
  return toDataUri(bytes, file.mimeType);
}

/**
 * Makes a request's first frame, reference images and reference audio
 * readable by fal, one at a time, in that order. After an initiate failure
 * the remaining files of this call go as data URIs.
 *
 * @param ctx - Plugin context (`config.upload`, `config.uploadUrl`, `config.timeoutMs`, `log`).
 * @param image - The first frame.
 * @param references - Image refs and audio refs, already checked against the model's limits.
 * @param references.images - Reference images.
 * @param references.audio - Reference audio files.
 * @param options - Key and caller signal.
 * @returns URLs (or data URIs) for the image, each image ref and each audio ref, in order.
 * @throws {RetryableProviderError} When a storage PUT fails with 5xx/429/timeout/network.
 * @throws {TerminalProviderError} When a storage PUT fails with another status.
 * @throws {Error} When a file cannot be read.
 * @example
 * ```ts
 * const urls = await uploadInputs(ctx, request.image, { images: [], audio: [] }, { apiKey });
 * ```
 */
export async function uploadInputs(
  ctx: FalContext,
  image: VideoFile,
  references: { images: readonly VideoFile[]; audio: readonly VideoFile[] },
  options: UploadOptions
): Promise<UploadedUrls> {
  const session: UploadSession = { mode: ctx.config.upload };
  const imageUrl = await uploadOne(ctx, session, image, options);

  const refUrls: string[] = [];
  for (const reference of references.images) {
    refUrls.push(await uploadOne(ctx, session, reference, options));
  }

  const audioReferenceUrls: string[] = [];
  for (const reference of references.audio) {
    audioReferenceUrls.push(await uploadOne(ctx, session, reference, options));
  }
  return { image: imageUrl, refs: refUrls, audioRefs: audioReferenceUrls };
}
