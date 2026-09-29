/**
 * @file apimodels video poll — reads a task once and maps it to the video
 * contract's poll: pending, failed with the classified error, or done with
 * the downloaded clip and its real charge. A key that is missing or refused
 * at poll time throws a plain error: the runner marks the job expired, and
 * the next run adopts the same task. The key read and the failed-task
 * classification are exported for `submit` (`./handler.ts`) too: a task that
 * failed at once in the submit response is read like a failed poll.
 */
import type { VideoJobPoll, VideoRequest } from "../../video/contract";
import { invalidateStaleAssets, isStaleAssetFailure, usedAssetsOf } from "../assets";
import type { ApiResponse } from "../client";
import { apiData, apiFetch, cleanText, isEmpty, suffixOf } from "../client";
import { AUTH_STATUSES, BAD_REQUEST, CONTENT_MODERATION, RETRY_STATUS } from "../http";
import { roundUsd, videoCostUsd } from "../prices";
import type { ApimodelsContext, ApimodelsProviderError } from "../types";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "../types";
import type { UploadOptions } from "../upload";
import type { ApimodelsJob, TaskStatus } from "./job";
import { decodeJobId, readChargeUsd, readTask } from "./job";
import { requestSeconds } from "./models";

/** The one pending poll value. */
const PENDING: VideoJobPoll = { state: "pending" };

/** States while apimodels is still working on a task. */
const PENDING_STATES: ReadonlySet<string> = new Set(["pending", "processing"]);

/** State of a finished task. */
const COMPLETED = "completed";

/** State of a failed task, in a poll or already in the submit response. */
export const FAILED = "failed";

/** failCodes apimodels marks retryable (its `retryable` flag wins when present). */
const RETRYABLE_FAIL_CODES: ReadonlySet<string> = new Set([
  "UPSTREAM_BUSY",
  "UPSTREAM_FAILED",
  "TIMEOUT",
  "INTERNAL_ERROR",
  "OTHER"
]);

/** Download statuses of a result URL past its 7 days. */
const DEAD_RESULT_STATUSES: ReadonlySet<number> = new Set([403, 404, 410]);

/** Poll status of a task apimodels does not know. */
const TASK_UNKNOWN = 404;

/** MIME type used when the download names no video type. */
const DEFAULT_VIDEO_MIME = "video/mp4";

/** Log event for a task that ended with an error. */
const FAILED_EVENT = "apimodels:video:failed";

/**
 * Reads the key through the injected env API (MC3), at request time.
 *
 * @param ctx - Plugin context.
 * @returns The key, or undefined when it is not set.
 */
export function readApiKey(ctx: ApimodelsContext): string | undefined {
  const apiKey = ctx.env.get(ctx.config.apiKeyEnv);
  return isEmpty(apiKey) ? undefined : apiKey;
}

/**
 * The error of a poll without a valid key: a plain `Error` with no `status`
 * and no `kind`. The runner classifies it `unknown` and marks the job
 * expired, so the next run adopts the same task instead of paying again.
 *
 * @returns The error to throw.
 * @example
 * ```ts
 * pollKeyError().message; // => "[ai] apimodels cannot poll without a valid API key.\n  Fix APIMODELS_API_KEY; the next run adopts the same task."
 * ```
 */
function pollKeyError(): Error {
  return new Error(
    "[ai] apimodels cannot poll without a valid API key.\n  Fix APIMODELS_API_KEY; the next run adopts the same task."
  );
}

/**
 * The stale-asset answer for a request, when it named assets: the records are
 * dropped and the once-per-request verdict returned.
 *
 * @param ctx - Plugin context.
 * @param staleSeen - Request keys already answered stale in this process.
 * @param request - The resolved request.
 * @param apiKey - The API key (its fingerprint keys the records).
 * @returns The error, or undefined when the request named no assets.
 */
export function staleAssetError(
  ctx: ApimodelsContext,
  staleSeen: Set<string>,
  request: VideoRequest,
  apiKey: string
): ApimodelsProviderError | undefined {
  const used = usedAssetsOf(request, apiKey);
  if (used.hashes.length === 0) return undefined;
  return invalidateStaleAssets(ctx, staleSeen, used);
}

/**
 * Classifies a failed task: content moderation is flagged; `INVALID_INPUT`
 * naming an asset is the stale path; `data.retryable`, else the failCode,
 * decides retryable (503) or terminal (400). Messages carry apimodels' text,
 * without the key or the prompt.
 *
 * @param ctx - Plugin context.
 * @param staleSeen - Request keys already answered stale in this process.
 * @param task - The failed task.
 * @param request - The resolved request.
 * @param apiKey - The API key.
 * @returns The classified error.
 */
export function taskFailure(
  ctx: ApimodelsContext,
  staleSeen: Set<string>,
  task: TaskStatus,
  request: VideoRequest,
  apiKey: string
): ApimodelsProviderError {
  const detail = cleanText(task.failMsg, [apiKey, request.prompt]);
  const label = task.failCode ?? "unknown";

  // Moderation is final; a stale asset gets one more registration.
  if (task.failCode === CONTENT_MODERATION) {
    return new FlaggedProviderError(
      `[ai] apimodels flagged the task (content moderation)${suffixOf(detail)}.\n  Change the prompt or the inputs.`
    );
  }
  const stale = isStaleAssetFailure(task.failCode, task.failMsg)
    ? staleAssetError(ctx, staleSeen, request, apiKey)
    : undefined;
  if (stale !== undefined) return stale;

  // apimodels' own retry verdict wins; else its failCode decides.
  const isRetryable = task.retryable ?? RETRYABLE_FAIL_CODES.has(task.failCode ?? "");
  if (isRetryable) {
    return new RetryableProviderError(
      `[ai] apimodels task failed (${label})${suffixOf(detail)}.\n  The runner submits it again.`,
      { status: RETRY_STATUS }
    );
  }
  return new TerminalProviderError(
    `[ai] apimodels task failed (${label})${suffixOf(detail)}.\n  Check the request fields against the apimodels docs.`,
    BAD_REQUEST,
    { failCode: task.failCode, detail }
  );
}

/**
 * Loggable fields of a failure: class, status and kind only.
 *
 * @param error - The classified error.
 * @returns Redacted log fields.
 * @example
 * ```ts
 * redacted(new TerminalProviderError("[ai] x.\n  y.", 400)); // => { errorType: "terminal", status: 400 }
 * ```
 */
function redacted(error: ApimodelsProviderError): {
  errorType: "retryable" | "terminal" | "flagged";
  status?: number | undefined;
  kind?: string;
} {
  if (error instanceof FlaggedProviderError) return { errorType: "flagged", kind: error.kind };
  if (error instanceof TerminalProviderError) {
    return { errorType: "terminal", status: error.status };
  }
  return { errorType: "retryable", status: error.status };
}

/**
 * A failed poll, logged with ids and the error class only.
 *
 * @param ctx - Plugin context (log).
 * @param job - The job.
 * @param error - The classified error.
 * @returns The failed poll.
 */
function failedPoll(
  ctx: ApimodelsContext,
  job: ApimodelsJob,
  error: ApimodelsProviderError
): VideoJobPoll {
  ctx.log.warn(FAILED_EVENT, { taskId: job.taskId, ...redacted(error) });
  return { state: "failed", error };
}

/**
 * Whether a poll failure says apimodels refused the key.
 *
 * @param error - What the poll call threw.
 * @returns True for a terminal 401 or 403.
 * @example
 * ```ts
 * isKeyRejection(new TerminalProviderError("x", 403)); // => true
 * ```
 */
function isKeyRejection(error: unknown): boolean {
  return error instanceof TerminalProviderError && AUTH_STATUSES.has(error.status);
}

/**
 * Whether a poll failure says apimodels does not know the task.
 *
 * @param error - What the poll call threw.
 * @returns True for a terminal 404.
 * @example
 * ```ts
 * isTaskUnknown(new TerminalProviderError("x", 404)); // => true
 * ```
 */
function isTaskUnknown(error: unknown): boolean {
  return error instanceof TerminalProviderError && error.status === TASK_UNKNOWN;
}

/**
 * The poll for a task apimodels does not know (poll 404): failed with a
 * retryable 503, `kind: "resubmit"`, so the runner submits anew without
 * counting it against the lane breaker.
 *
 * @param ctx - Plugin context (log).
 * @param job - The job.
 * @returns The failed poll.
 */
function lostTaskPoll(ctx: ApimodelsContext, job: ApimodelsJob): VideoJobPoll {
  const lost = new RetryableProviderError(
    `[ai] apimodels does not know task "${job.taskId}" (HTTP 404).\n  The runner submits it again, and it is paid again.`,
    { status: RETRY_STATUS, kind: "resubmit" }
  );
  return failedPoll(ctx, job, lost);
}

/**
 * The poll for a download that failed: a dead result URL (7 days passed)
 * returns failed with a retryable 503, `kind: "resubmit"`, so the runner
 * submits anew; another 4xx is thrown as a retryable 503 (poll again, the
 * clip is paid for); any other failure is thrown as is.
 *
 * @param ctx - Plugin context (log).
 * @param job - The job.
 * @param error - What the download threw.
 * @returns The failed poll for a dead URL.
 * @throws {RetryableProviderError} For any other failure.
 */
function downloadFailure(ctx: ApimodelsContext, job: ApimodelsJob, error: unknown): VideoJobPoll {
  if (!(error instanceof TerminalProviderError)) throw error;

  if (DEAD_RESULT_STATUSES.has(error.status)) {
    return failedPoll(
      ctx,
      job,
      new RetryableProviderError(
        `[ai] apimodels finished the task, but its result is gone (HTTP ${error.status}).\n  Results live 7 days; the runner submits the task again, and it is paid again.`,
        { status: RETRY_STATUS, kind: "resubmit" }
      )
    );
  }
  ctx.log.warn("apimodels:result:unreadable", { taskId: job.taskId, status: error.status });
  throw new RetryableProviderError(
    `[ai] apimodels finished the task, but its result could not be read (HTTP ${error.status}).\n  Poll it again; the runner does this on its own.`,
    { status: RETRY_STATUS }
  );
}

/**
 * The real charge of a task, when apimodels has settled it in USD. Never
 * fails the poll: any error reads as "no charge yet".
 *
 * @param ctx - Plugin context.
 * @param job - The job.
 * @param apiKey - The API key.
 * @param signal - Caller abort signal.
 * @returns USD charged, or undefined.
 */
async function settledChargeUsd(
  ctx: ApimodelsContext,
  job: ApimodelsJob,
  apiKey: string,
  signal: AbortSignal | undefined
): Promise<number | undefined> {
  try {
    const data = await apiData(
      {
        url: `${ctx.config.baseUrl}/records/${encodeURIComponent(job.taskId)}`,
        method: "GET",
        apiKey,
        timeoutMs: ctx.config.timeoutMs,
        signal
      },
      "records response"
    );
    return readChargeUsd(data);
  } catch {
    ctx.log.debug("apimodels:records:unavailable", { taskId: job.taskId });
    return undefined;
  }
}

/**
 * The clip's MIME type: the download's `video/*` content type, else video/mp4.
 *
 * @param response - The download.
 * @returns The MIME type.
 * @example
 * ```ts
 * mimeTypeOf({ status: 200, headers: new Headers({ "content-type": "video/quicktime" }), body: new Uint8Array() }); // => "video/quicktime"
 * ```
 */
function mimeTypeOf(response: ApiResponse): string {
  const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  return type.startsWith("video/") ? type : DEFAULT_VIDEO_MIME;
}

/**
 * Finishes a completed task: downloads `resultUrls[0]` (without the key: the
 * result host is not apimodels), then prices it with the settled charge, or
 * the table price, plus the asset registrations of its submit.
 *
 * @param ctx - Plugin context.
 * @param job - The job.
 * @param task - The completed task.
 * @param request - The request the job was submitted with.
 * @param options - Key and caller signal.
 * @returns A done poll, or a failed one for a dead result URL.
 * @throws {RetryableProviderError} When there is no result URL yet, or the clip cannot be read.
 */
async function finishTask(
  ctx: ApimodelsContext,
  job: ApimodelsJob,
  task: TaskStatus,
  request: VideoRequest,
  options: UploadOptions
): Promise<VideoJobPoll> {
  // A completed task without a URL may still be writing it: poll again.
  if (task.resultUrl === undefined) {
    throw new RetryableProviderError(
      "[ai] apimodels finished the task without a result URL.\n  Poll it again; the runner does this on its own.",
      { status: RETRY_STATUS }
    );
  }

  // Download the clip; a dead URL fails the job so the runner submits anew.
  let download: ApiResponse;
  try {
    download = await apiFetch({
      url: task.resultUrl,
      method: "GET",
      timeoutMs: ctx.config.timeoutMs,
      signal: options.signal
    });
  } catch (error) {
    return downloadFailure(ctx, job, error);
  }

  // Price: the settled charge, else the table; plus the asset registrations.
  const chargeUsd = await settledChargeUsd(ctx, job, options.apiKey, options.signal);
  const videoUsd = chargeUsd ?? videoCostUsd(ctx, request);
  ctx.log.info("apimodels:video:done", { taskId: job.taskId, bytes: download.body.length });
  return {
    state: "done",
    video: download.body,
    mimeType: mimeTypeOf(download),
    costUsd: roundUsd(videoUsd + job.assetUsd),
    meta: { taskId: job.taskId, model: job.model, seconds: requestSeconds(request) }
  };
}

/**
 * Polls a task once: pending, failed with the classified error, or done
 * with the downloaded clip. A poll 404 (task unknown) returns failed with a
 * retryable 503, `kind: "resubmit"`; a 429, 5xx, timeout or network failure
 * is thrown, so the runner keeps the job pending. A corrupt job id, or a key
 * missing or refused (401/403), is thrown as a plain error, so the runner
 * marks the job expired and a later run adopts the same task.
 *
 * @param ctx - Plugin context.
 * @param staleSeen - Request keys already answered stale in this process.
 * @param jobId - The id `submit` returned.
 * @param request - The request the job was submitted with.
 * @param signal - Caller abort signal.
 * @returns The poll result.
 */
export async function pollJob(
  ctx: ApimodelsContext,
  staleSeen: Set<string>,
  jobId: string,
  request: VideoRequest,
  signal: AbortSignal | undefined
): Promise<VideoJobPoll> {
  // Without a valid key the task stays adoptable: the job must not read as failed.
  const job = decodeJobId(jobId);
  const apiKey = readApiKey(ctx);
  if (apiKey === undefined) throw pollKeyError();

  // Read the task once; a task apimodels does not know is lost, so the runner submits anew.
  let data: unknown;
  try {
    data = await apiData(
      {
        url: `${ctx.config.baseUrl}/video/generations?task_id=${encodeURIComponent(job.taskId)}`,
        method: "GET",
        apiKey,
        timeoutMs: ctx.config.timeoutMs,
        signal,
        redact: [request.prompt]
      },
      "poll response"
    );
  } catch (error) {
    if (isKeyRejection(error)) throw pollKeyError();
    if (!isTaskUnknown(error)) throw error;
    return lostTaskPoll(ctx, job);
  }

  // The state is the truth: completed, failed, or still working.
  const task = readTask(data);
  if (task.state === COMPLETED) return finishTask(ctx, job, task, request, { apiKey, signal });
  if (task.state === FAILED) {
    return failedPoll(ctx, job, taskFailure(ctx, staleSeen, task, request, apiKey));
  }
  if (!PENDING_STATES.has(task.state ?? "")) {
    ctx.log.warn("apimodels:poll:unknown-state", { taskId: job.taskId, state: task.state });
  }
  return PENDING;
}
