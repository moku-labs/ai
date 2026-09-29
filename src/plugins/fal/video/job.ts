/**
 * @file fal video result narrowing — where the finished clip is. The job id
 * codec and the queue-response narrowing live in `../client/queue.ts` (shared
 * by every task) and are re-exported here, so the video handler's imports stay.
 */
import { readField, readString } from "../client/http";

export type { FalJob } from "../client/queue";
export { decodeJobId, encodeJobId, hasJobError, parseSubmitResponse } from "../client/queue";

/**
 * Where the finished clip is, narrowed from fal's result body.
 */
export type FalVideoFile = {
  /** CDN URL of the clip. */
  url: string;
  /** MIME type fal reported, if any. */
  contentType: string | undefined;
};

/**
 * Narrows fal's result body to the clip location.
 *
 * @param body - Parsed result response.
 * @returns The clip URL and MIME type.
 * @throws {Error} A plain (terminal) error when `video.url` is missing.
 * @example
 * ```ts
 * parseVideoResult({ video: { url: "https://cdn/clip.mp4" } }); // => { url: "https://cdn/clip.mp4", contentType: undefined }
 * ```
 */
export function parseVideoResult(body: unknown): FalVideoFile {
  const video = readField(body, "video");
  const url = readString(video, "url");
  if (url === undefined) {
    throw new Error(
      "[ai] fal returned an incomplete result.\n  Expected video.url in the response."
    );
  }
  return { url, contentType: readString(video, "content_type") };
}
