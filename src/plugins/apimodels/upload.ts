/**
 * @file apimodels input upload — turns local `VideoFile`s into https URLs
 * apimodels can read (`POST /files`, multipart field `file`; files live 7
 * days upstream). A URL is cached in `state.uploads` for the process, keyed
 * by MIME type and the `VideoFile.hash` the runner delivered (never
 * recomputed). One call uploads each distinct file once, at most
 * {@link SLOTS} at a time; a 429 waits `Retry-After` once before it is thrown.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { VideoFile } from "../video/contract";
import { apiData, readString, withRateLimitWait } from "./client";
import type { ApimodelsContext } from "./types";
import { TerminalProviderError } from "./types";

/**
 * Per-call upload options.
 *
 * @example
 * ```ts
 * const options: UploadOptions = { apiKey: "key" };
 * ```
 */
export type UploadOptions = {
  /** API key for the upload call. */
  apiKey: string;
  /** Caller abort signal. */
  signal?: AbortSignal | undefined;
};

/** How many uploads (and, in `assets.ts`, registrations) of one submit run at once. */
export const SLOTS = 4;

/** File extensions by MIME type, for the uploaded file name. */
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

/** Status of an unreadable input or an incomplete response: terminal, retrying cannot help. */
const BAD_REQUEST = 400;

/**
 * Upload file name: the first 16 hash characters plus an extension from the
 * MIME type, else from the path, else `bin`.
 *
 * @param file - The input file.
 * @returns File name, e.g. `"abcd1234abcd1234.png"`.
 * @example
 * ```ts
 * fileNameOf({ path: "/a/b.png", mimeType: "image/png", hash: "abcd1234abcd1234ffff" }); // => "abcd1234abcd1234.png"
 * ```
 */
export function fileNameOf(file: VideoFile): string {
  const fromPath = path.extname(file.path).slice(1).toLowerCase();
  const extension = EXTENSIONS[file.mimeType] ?? (fromPath === "" ? "bin" : fromPath);
  return `${file.hash.slice(0, 16)}.${extension}`;
}

/**
 * Cache key of an uploaded file: MIME type and the delivered hash.
 *
 * @param file - The input file.
 * @returns `file:<mime>:<hash>`.
 * @example
 * ```ts
 * uploadKey({ path: "/a.png", mimeType: "image/png", hash: "ab12" }); // => "file:image/png:ab12"
 * ```
 */
export function uploadKey(file: VideoFile): string {
  return `file:${file.mimeType}:${file.hash}`;
}

/**
 * Runs `work` on every item, at most `slots` at a time, and keeps the
 * results in item order. After a failure no new item starts; the call waits
 * for the running ones, then rejects with the first error.
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
export async function mapInSlots<Item, Result>(
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
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(slots, items.length) }, () => runSlot())
  );

  // Every slot has settled: surface the first failure, if any.
  const rejection = outcomes.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
  );
  if (rejection) throw rejection.reason;
  return results;
}

/**
 * Reads an input file's bytes.
 *
 * @param file - The input file.
 * @returns The bytes.
 * @throws {TerminalProviderError} A 400 when the file cannot be read.
 */
async function readInput(file: VideoFile): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(file.path));
  } catch {
    throw new TerminalProviderError(
      `[ai] Cannot read apimodels input file "${file.path}".\n  Check that the $ref or $file it came from still exists.`,
      BAD_REQUEST
    );
  }
}

/**
 * Uploads one file with `POST /files` and returns its public URL.
 *
 * @param ctx - Plugin context (`config.baseUrl`, `config.timeoutMs`).
 * @param file - The input file.
 * @param bytes - The file bytes.
 * @param options - Key and caller signal.
 * @returns The public URL.
 * @throws {TerminalProviderError} When the response has no `publicUrl`.
 */
async function postFile(
  ctx: ApimodelsContext,
  file: VideoFile,
  bytes: Uint8Array,
  options: UploadOptions
): Promise<string> {
  // A fresh form per try: the multipart body is read once by fetch.
  const send = (): Promise<unknown> => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(bytes)], { type: file.mimeType }),
      fileNameOf(file)
    );
    return apiData(
      {
        url: `${ctx.config.baseUrl}/files`,
        method: "POST",
        apiKey: options.apiKey,
        form,
        timeoutMs: ctx.config.timeoutMs,
        signal: options.signal
      },
      "upload response"
    );
  };
  const data = await withRateLimitWait(send, ctx.config.timeoutMs, options.signal);

  const publicUrl = readString(data, "publicUrl");
  if (publicUrl === undefined) {
    throw new TerminalProviderError(
      "[ai] apimodels returned an incomplete upload response.\n  Expected data.publicUrl; check the apimodels API for a change.",
      BAD_REQUEST
    );
  }
  return publicUrl;
}

/**
 * Makes one file readable by apimodels: its cached URL, or a new upload.
 *
 * @param ctx - Plugin context (`state.uploads`).
 * @param file - The input file.
 * @param options - Key and caller signal.
 * @returns The public URL.
 */
async function uploadOne(
  ctx: ApimodelsContext,
  file: VideoFile,
  options: UploadOptions
): Promise<string> {
  const key = uploadKey(file);
  const cached = ctx.state.uploads.get(key);
  if (cached !== undefined) return cached;

  const url = await postFile(ctx, file, await readInput(file), options);
  ctx.state.uploads.set(key, url);
  return url;
}

/**
 * Makes files readable by apimodels: each distinct file (by upload key) is
 * uploaded once, at most {@link SLOTS} at a time, or taken from the cache.
 *
 * @param ctx - Plugin context (`config`, `state.uploads`).
 * @param files - The input files, duplicates allowed.
 * @param options - Key and caller signal.
 * @returns The public URL of each file, in input order.
 * @throws {TerminalProviderError} When a file cannot be read or a response is incomplete.
 */
export async function uploadFiles(
  ctx: ApimodelsContext,
  files: readonly VideoFile[],
  options: UploadOptions
): Promise<string[]> {
  // One upload per distinct file, even when a request names the same bytes twice.
  const distinct = [...new Map(files.map(file => [uploadKey(file), file])).values()];
  const urls = await mapInSlots(distinct, SLOTS, file => uploadOne(ctx, file, options));

  // Map the URLs back onto the input order.
  const urlByKey = new Map(distinct.map((file, index) => [uploadKey(file), urls[index] ?? ""]));
  return files.map(file => urlByKey.get(uploadKey(file)) ?? "");
}
