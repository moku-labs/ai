/**
 * @file fal input upload — turns resolved local files into URLs fal can read,
 * for every task. `"storage"` mode initiates a fal storage upload, PUTs the
 * bytes to the presigned URL and sends the returned file URL. When an upload
 * fails, the rest of that upload session falls back to base64 data URIs
 * (logged once as `fal:upload:fallback`). `"data-uri"` mode always inlines.
 * Files of one call upload in parallel, at most {@link UPLOAD_SLOTS} at a
 * time, in order. A storage URL is cached in `state.uploads` by MIME type and
 * content sha256, so the same bytes are uploaded once per process, across tasks.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FalContext, LocalFile, UploadMode } from "../types";
import { RetryableProviderError, TerminalProviderError } from "../types";
import { falFetch, parseJson, readString } from "./http";

/**
 * Per-call upload options.
 *
 * @example
 * ```ts
 * const options: UploadOptions = { apiKey: "fal-key" };
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
 */
type StorageTarget = {
  /** Presigned PUT URL. */
  uploadUrl: string;
  /** Public file URL sent to the model. */
  fileUrl: string;
};

/**
 * Mutable mode of one upload session: starts at `config.upload` and drops to
 * `"data-uri"` after an upload failure, for every later file of the session.
 *
 * @example
 * ```ts
 * const session: UploadSession = { mode: "storage" };
 * ```
 */
export type UploadSession = {
  /** Current mode; `"data-uri"` after the first failed upload. */
  mode: UploadMode;
};

/**
 * How many uploads of one call run at once.
 *
 * @example
 * ```ts
 * UPLOAD_SLOTS; // => 4
 * ```
 */
export const UPLOAD_SLOTS = 4;

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
 * fileNameOf({ path: "/a/b.png", mimeType: "image/png", hash: "abcd1234abcd1234ffff" }); // => "abcd1234abcd1234.png"
 * ```
 */
export function fileNameOf(file: LocalFile): string {
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
 */
async function readInput(file: LocalFile): Promise<Uint8Array> {
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
 */
async function initiate(
  ctx: FalContext,
  file: LocalFile,
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
  const isIncomplete = uploadUrl === undefined || fileUrl === undefined;
  if (isIncomplete) {
    throw new Error(
      "[ai] fal returned an incomplete upload response.\n  Expected upload_url and file_url."
    );
  }
  return { uploadUrl, fileUrl };
}

/**
 * Cache key of a file in fal storage: storage mode, MIME type and the
 * sha256 of the bytes, so the same content is found under any path.
 *
 * @param mimeType - File MIME type.
 * @param bytes - File bytes.
 * @returns `storage:<mime>:<sha256 hex>`.
 * @example
 * ```ts
 * uploadKey("image/png", new TextEncoder().encode("test")); // => "storage:image/png:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
 * ```
 */
function uploadKey(mimeType: string, bytes: Uint8Array): string {
  return `storage:${mimeType}:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Switches the session to data URIs after a failed upload. Only the first
 * failure of a session logs `fal:upload:fallback`, also when parallel uploads
 * fail together.
 *
 * @param ctx - Plugin context (log).
 * @param session - The session's upload mode.
 * @param error - What the upload threw.
 * @returns {void} Nothing; the session is switched to data URIs.
 */
function fallBack(ctx: FalContext, session: UploadSession, error: unknown): void {
  if (session.mode === "storage") ctx.log.warn("fal:upload:fallback", { status: statusOf(error) });
  session.mode = "data-uri";
}

/**
 * Uploads one file to fal storage. Returns undefined, after switching the
 * session to data URIs, when the initiate call or the PUT fails; a caller
 * abort is rethrown.
 *
 * @param ctx - Plugin context.
 * @param session - The session's upload mode.
 * @param file - The input file.
 * @param bytes - The file bytes.
 * @param options - Key and caller signal.
 * @returns The public file URL, or undefined to fall back to a data URI.
 */
async function uploadToStorage(
  ctx: FalContext,
  session: UploadSession,
  file: LocalFile,
  bytes: Uint8Array,
  options: UploadOptions
): Promise<string | undefined> {
  // Ask fal storage where to PUT the file; a failure (not an abort) drops the session to data URIs.
  let target: StorageTarget;
  try {
    target = await initiate(ctx, file, options);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    fallBack(ctx, session, error);
    return undefined;
  }

  // PUT the bytes to the presigned URL; a failure (not an abort) falls back the same way.
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
    fallBack(ctx, session, error);
    return undefined;
  }
  return target.fileUrl;
}

/**
 * Starts an upload session at `config.upload`.
 *
 * @param ctx - Plugin context (`config.upload`).
 * @returns A fresh session.
 */
export function createUploadSession(ctx: FalContext): UploadSession {
  return { mode: ctx.config.upload };
}

/**
 * Makes one file readable by fal: its cached storage URL, a new storage
 * upload, or a data URI.
 *
 * @param ctx - Plugin context (`config.upload`, `state.uploads`).
 * @param session - The session's upload mode (downgraded on an upload failure).
 * @param file - The input file.
 * @param options - Key and caller signal.
 * @returns A file URL or a data URI.
 * @throws {Error} When the file cannot be read, or the caller aborted.
 */
export async function uploadOne(
  ctx: FalContext,
  session: UploadSession,
  file: LocalFile,
  options: UploadOptions
): Promise<string> {
  const bytes = await readInput(file);
  if (ctx.config.upload === "data-uri") return toDataUri(bytes, file.mimeType);

  // The same bytes uploaded before in this process go by their URL again.
  const key = uploadKey(file.mimeType, bytes);
  const cached = ctx.state.uploads.get(key);
  if (cached !== undefined) return cached;

  // Only a storage URL is cached; a data-URI fallback never is.
  const url =
    session.mode === "storage"
      ? await uploadToStorage(ctx, session, file, bytes, options)
      : undefined;
  if (url === undefined) return toDataUri(bytes, file.mimeType);
  ctx.state.uploads.set(key, url);
  return url;
}

/**
 * Runs `work` on every item, at most `slots` at a time, and keeps the
 * results in item order. After a failure no new item starts; the call
 * rejects with the first error.
 *
 * @param items - The items.
 * @param slots - How many run at once.
 * @param work - What to do with one item.
 * @returns The results, in item order.
 * @example
 * ```ts
 * await mapInSlots([1, 2, 3], 2, async n => n * 10); // => [10, 20, 30]
 * ```
 */
async function mapInSlots<Item, Result>(
  items: readonly Item[],
  slots: number,
  work: (item: Item) => Promise<Result>
): Promise<Result[]> {
  const results: Result[] = [];
  const queue = items.entries();
  let failed = false;

  // Each slot takes the next item from the shared queue until it is empty or a slot failed.
  const runSlot = async (): Promise<void> => {
    for (const [index, item] of queue) {
      if (failed) return;
      try {
        results[index] = await work(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(slots, items.length) }, () => runSlot()));
  return results;
}

/**
 * Makes files readable by fal, {@link UPLOAD_SLOTS} at a time, keeping their
 * order. After an upload failure the remaining files of the session go as
 * data URIs. An empty list makes no call.
 *
 * @param ctx - Plugin context (`config.upload`, `config.uploadUrl`, `config.timeoutMs`, `state.uploads`, `log`).
 * @param files - The resolved files, in the order the body lists them.
 * @param options - Key and caller signal.
 * @param session - An open session to continue (the video first frame opens one); a new one by default.
 * @returns One URL (or data URI) per file, in file order.
 * @throws {Error} When a file cannot be read, or the caller aborted.
 */
export function uploadFiles(
  ctx: FalContext,
  files: readonly LocalFile[],
  options: UploadOptions,
  session: UploadSession = createUploadSession(ctx)
): Promise<string[]> {
  return mapInSlots(files, UPLOAD_SLOTS, file => uploadOne(ctx, session, file, options));
}
