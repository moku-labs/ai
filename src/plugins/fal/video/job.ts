/**
 * @file fal queue job helpers — the opaque job id the runner journals, the
 * narrowing of fal's queue responses (submit, status, result). fal's returned status
 * and result URLs are kept verbatim; they are never rebuilt from the model.
 */
import { readField, readString } from "../client";

/**
 * A submitted fal queue job: everything `poll` needs, journaled as JSON.
 *
 * @example
 * ```ts
 * const job: FalJob = { endpoint: "minimax/h3/image-to-video", requestId: "r1", statusUrl, responseUrl };
 * ```
 */
export type FalJob = {
  /** fal endpoint id the job was submitted to. */
  endpoint: string;
  /** fal request id. */
  requestId: string;
  /** Status URL returned by fal, used verbatim. */
  statusUrl: string;
  /** Result URL returned by fal, used verbatim. */
  responseUrl: string;
};

/**
 * Where the finished clip is, narrowed from fal's result body.
 *
 * @example
 * ```ts
 * const video: FalVideoFile = { url: "https://v3.fal.media/clip.mp4", contentType: "video/mp4" };
 * ```
 */
export type FalVideoFile = {
  /** CDN URL of the clip. */
  url: string;
  /** MIME type fal reported, if any. */
  contentType: string | undefined;
};

/** Longest slice of a bad job id quoted in an error message. */
const MAX_QUOTED_ID = 80;

/**
 * Encodes a job as the opaque id `submit` returns and the runner journals.
 *
 * @param job - The submitted job.
 * @returns JSON text.
 * @example
 * ```ts
 * encodeJobId(job); // => '{"endpoint":"...","requestId":"r1","statusUrl":"...","responseUrl":"..."}'
 * ```
 */
export function encodeJobId(job: FalJob): string {
  return JSON.stringify({
    endpoint: job.endpoint,
    requestId: job.requestId,
    statusUrl: job.statusUrl,
    responseUrl: job.responseUrl
  });
}

/**
 * Reads the four job fields off an untrusted value.
 *
 * @param value - Parsed JSON.
 * @returns The job, or undefined when a field is missing.
 * @example
 * ```ts
 * jobFrom(JSON.parse(jobId));
 * ```
 */
function jobFrom(value: unknown): FalJob | undefined {
  const endpoint = readString(value, "endpoint");
  const requestId = readString(value, "requestId");
  const statusUrl = readString(value, "statusUrl");
  const responseUrl = readString(value, "responseUrl");
  const isComplete =
    endpoint !== undefined &&
    requestId !== undefined &&
    statusUrl !== undefined &&
    responseUrl !== undefined;
  return isComplete ? { endpoint, requestId, statusUrl, responseUrl } : undefined;
}

/**
 * Decodes the job id `submit` returned.
 *
 * @param jobId - The journaled job id.
 * @returns The job.
 * @throws {Error} A plain (terminal) error when the id is not a fal job id.
 * @example
 * ```ts
 * const job = decodeJobId(jobId);
 * ```
 */
export function decodeJobId(jobId: string): FalJob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jobId);
  } catch {
    parsed = undefined;
  }
  const job = jobFrom(parsed);
  if (job === undefined) {
    throw new Error(
      `[ai] fal job id "${jobId.slice(0, MAX_QUOTED_ID)}" is not valid.\n  Expected the JSON job id returned by fal submit.`
    );
  }
  return job;
}

/**
 * Narrows fal's submit response into a job.
 *
 * @param body - Parsed submit response.
 * @param endpoint - The endpoint the job was submitted to.
 * @returns The job.
 * @throws {Error} A plain (terminal) error when a queue field is missing.
 * @example
 * ```ts
 * const job = parseSubmitResponse(body, "minimax/h3/image-to-video");
 * ```
 */
export function parseSubmitResponse(body: unknown, endpoint: string): FalJob {
  const job = jobFrom({
    endpoint,
    requestId: readString(body, "request_id"),
    statusUrl: readString(body, "status_url"),
    responseUrl: readString(body, "response_url")
  });
  if (job === undefined) {
    throw new Error(
      "[ai] fal returned an incomplete submit response.\n  Expected request_id, status_url and response_url."
    );
  }
  return job;
}

/**
 * Whether a COMPLETED status body carries a job error.
 *
 * @param body - Parsed status response.
 * @returns True when `error` is present and not null.
 * @example
 * ```ts
 * hasJobError({ status: "COMPLETED", error: "timeout" }); // => true
 * ```
 */
export function hasJobError(body: unknown): boolean {
  const error = readField(body, "error");
  return error !== undefined && error !== null;
}

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
