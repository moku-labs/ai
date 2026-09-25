/**
 * @file fal input upload — turns local `VideoFile`s into URLs fal can read.
 * `"storage"` mode initiates a fal storage upload, PUTs the bytes to the
 * presigned URL and sends the returned file URL. When an upload fails, the
 * rest of that request falls back to base64 data URIs (logged once as
 * `fal:upload:fallback`). `"data-uri"` mode always inlines. The first frame
 * goes first, then the refs in parallel, at most {@link UPLOAD_SLOTS} at a
 * time. A storage URL is cached in `state.uploads` by MIME type and content
 * sha256, so the same bytes are uploaded once per process.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { VideoFile } from "../video/contract";
import { falFetch, parseJson, readString } from "./client";
import type { SplitReferences, UploadedUrls } from "./models";
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
 */
type StorageTarget = {
  /** Presigned PUT URL. */
  uploadUrl: string;
  /** Public file URL sent to the model. */
  fileUrl: string;
};

/**
 * Mutable mode of one upload call: starts at `config.upload` and drops to
 * `"data-uri"` after an upload failure.
 */
type UploadSession = { mode: UploadMode };

/** How many ref uploads of one request run at once. */
const UPLOAD_SLOTS = 4;

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
 * Cache key of a file in fal storage: storage mode, MIME type and the
 * sha256 of the bytes, so the same content is found under any path.
 *
 * @param mimeType - File MIME type.
 * @param bytes - File bytes.
 * @returns `storage:<mime>:<sha256 hex>`.
 * @example
 * ```ts
 * uploadKey("image/png", bytes); // => "storage:image/png:9f86d0..."
 * ```
 */
function uploadKey(mimeType: string, bytes: Uint8Array): string {
  return `storage:${mimeType}:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Switches the call to data URIs after a failed upload. Only the first
 * failure of a call logs `fal:upload:fallback`, also when parallel uploads
 * fail together.
 *
 * @param ctx - Plugin context (log).
 * @param session - The call's upload mode.
 * @param error - What the upload threw.
 * @example
 * ```ts
 * fallBack(ctx, session, error);
 * ```
 */
function fallBack(ctx: FalContext, session: UploadSession, error: unknown): void {
  if (session.mode === "storage") ctx.log.warn("fal:upload:fallback", { status: statusOf(error) });
  session.mode = "data-uri";
}

/**
 * Uploads one file to fal storage. Returns undefined, after switching the
 * call to data URIs, when the initiate call or the PUT fails; a caller abort
 * is rethrown.
 *
 * @param ctx - Plugin context.
 * @param session - The call's upload mode.
 * @param file - The input file.
 * @param bytes - The file bytes.
 * @param options - Key and caller signal.
 * @returns The public file URL, or undefined to fall back to a data URI.
 * @example
 * ```ts
 * const url = await uploadToStorage(ctx, session, file, bytes, options);
 * ```
 */
async function uploadToStorage(
  ctx: FalContext,
  session: UploadSession,
  file: VideoFile,
  bytes: Uint8Array,
  options: UploadOptions
): Promise<string | undefined> {
  let target: StorageTarget;
  try {
    target = await initiate(ctx, file, options);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    fallBack(ctx, session, error);
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
    fallBack(ctx, session, error);
    return undefined;
  }
  return target.fileUrl;
}

/**
 * Makes one file readable by fal: its cached storage URL, a new storage
 * upload, or a data URI.
 *
 * @param ctx - Plugin context (`config.upload`, `state.uploads`).
 * @param session - The call's upload mode (downgraded on an upload failure).
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
 * const urls = await mapInSlots(files, 4, file => uploadOne(ctx, session, file, options));
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
 * Makes a request's first frame and refs readable by fal: the first frame
 * first, then the image, audio and video refs in parallel, at most
 * {@link UPLOAD_SLOTS} at a time. After an upload failure the remaining
 * files of this call go as data URIs.
 *
 * @param ctx - Plugin context (`config.upload`, `config.uploadUrl`, `config.timeoutMs`, `state.uploads`, `log`).
 * @param image - The first frame.
 * @param references - Image, audio and video refs, already checked against the model's limits.
 * @param options - Key and caller signal.
 * @returns URLs (or data URIs) for the image and for each image, audio and video ref, in order.
 * @throws {Error} When a file cannot be read, or the caller aborted.
 * @example
 * ```ts
 * const urls = await uploadInputs(ctx, request.image, { images: [], audio: [], videos: [] }, { apiKey });
 * ```
 */
export async function uploadInputs(
  ctx: FalContext,
  image: VideoFile,
  references: SplitReferences,
  options: UploadOptions
): Promise<UploadedUrls> {
  // The first frame goes first, alone; a failure here flips the session to data-uri
  const session: UploadSession = { mode: ctx.config.upload };
  const imageUrl = await uploadOne(ctx, session, image, options);

  // Every ref in parallel, UPLOAD_SLOTS at a time, in request order
  const files = [...references.images, ...references.audio, ...references.videos];
  const urls = await mapInSlots(files, UPLOAD_SLOTS, file =>
    uploadOne(ctx, session, file, options)
  );

  // Slice the flat URL list back into the three groups
  const audioStart = references.images.length;
  const videoStart = audioStart + references.audio.length;
  return {
    image: imageUrl,
    refs: urls.slice(0, audioStart),
    audioRefs: urls.slice(audioStart, videoStart),
    videoRefs: urls.slice(videoStart)
  };
}
