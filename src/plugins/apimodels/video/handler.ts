/**
 * @file apimodels video handler — implements the task-owned contract
 * (`../../video/contract.ts`) over the apimodels task API. `estimate` is
 * network-free. `submit` uploads the plain inputs, resolves the inputs named
 * in `params.assets` to `asset://` ids, and POSTs the task. `poll` reads the
 * task once and, when it is completed, downloads the clip and reads the real
 * charge. There is no `execute`: the runner and the `video` facade both drive
 * `submit` + `poll`. The job id is JSON (task id, alias, asset cost), so a
 * restart adopts the task instead of paying again. A key that is missing or
 * refused at poll time throws a plain error: the runner marks the job
 * expired, and the next run adopts the same task.
 */
import type {
  EstimateRequest,
  VideoFile,
  VideoHandler,
  VideoJobPoll,
  VideoRequest
} from "../../video/contract";
import {
  invalidateStaleAssets,
  isStaleAssetFailure,
  isStaleAssetRejection,
  listInputs,
  readAssetSelectors,
  resolveAssets,
  selectAssetFiles,
  usedAssetsOf
} from "../assets";
import type { ApiResponse } from "../client";
import { apiData, apiFetch, cleanText, suffixOf } from "../client";
import { assetPriceUsd, roundUsd, videoCostUsd } from "../prices";
import type { ApimodelsContext, ApimodelsProviderError } from "../types";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "../types";
import type { UploadOptions } from "../upload";
import { uploadFiles } from "../upload";
import type { ApimodelsJob, TaskStatus } from "./job";
import { decodeJobId, encodeJobId, readChargeUsd, readTask } from "./job";
import type { InputUrls, ReferenceKind, ResolvedModel } from "./models";
import { buildBody, checkRequest, referenceKindOf, requestSeconds, resolveModel } from "./models";

/** The apimodels video handler: the async form of the contract (no `execute`). */
export type ApimodelsVideoHandler = Required<Pick<VideoHandler, "estimate" | "submit" | "poll">>;

/**
 * What `submit` POSTs: the validated model and request, the input URLs and the key.
 */
type Submission = {
  /** The resolved catalog row. */
  model: ResolvedModel;
  /** The validated request. */
  request: VideoRequest;
  /** URLs (https or `asset://`) of the inputs. */
  urls: InputUrls;
  /** The API key. */
  apiKey: string;
};

/** The one pending poll value. */
const PENDING: VideoJobPoll = { state: "pending" };

/** States while apimodels is still working on a task. */
const PENDING_STATES: ReadonlySet<string> = new Set(["pending", "processing"]);

/** State of a finished task. */
const COMPLETED = "completed";

/** State of a failed task. */
const FAILED = "failed";

/** failCode of a content-moderation rejection. */
const CONTENT_MODERATION = "CONTENT_MODERATION";

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

/** Statuses apimodels answers for a bad or missing key. */
const AUTH_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/** Status of a failure the runner should retry by submitting (or polling) again. */
const RETRY_STATUS = 503;

/** Status of a request apimodels refused for good. */
const BAD_REQUEST = 400;

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
function readApiKey(ctx: ApimodelsContext): string | undefined {
  const apiKey = ctx.env.get(ctx.config.apiKeyEnv);
  return apiKey === undefined || apiKey === "" ? undefined : apiKey;
}

/**
 * Reads the key for a submit.
 *
 * @param ctx - Plugin context.
 * @returns The key.
 * @throws {TerminalProviderError} A 401 when the key is not set.
 */
function resolveApiKey(ctx: ApimodelsContext): string {
  const apiKey = readApiKey(ctx);
  if (apiKey === undefined) {
    throw new TerminalProviderError(
      "[ai] apimodels needs an API key.\n  Set APIMODELS_API_KEY (or the env var named by apimodels.apiKeyEnv).",
      401
    );
  }
  return apiKey;
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
 * Estimate of a request, network-free and on unresolved inputs: validation,
 * then the table price plus one asset price per `params.assets` entry (a
 * worst case: the cache is not visible here).
 *
 * @param ctx - Plugin context (price table).
 * @param request - The request, resolved or not.
 * @returns USD, rounded to micro-dollars.
 * @throws {TerminalProviderError} A 400 for anything submit would refuse.
 */
function estimateUsd(ctx: ApimodelsContext, request: EstimateRequest): number {
  const model = resolveModel(request.model);
  checkRequest(model, request);
  const assetCount = readAssetSelectors(request).length;
  return roundUsd(videoCostUsd(ctx, request) + assetCount * assetPriceUsd(ctx));
}

/**
 * Splits the per-selector URLs into the body's input fields, refs by MIME.
 *
 * @param request - The resolved request.
 * @param urlBySelector - URL of each input, by selector.
 * @returns The input URLs.
 * @example
 * ```ts
 * splitUrls({ model: "m", prompt: "p", refs: [{ path: "/v.mp3", mimeType: "audio/mpeg", hash: "c" }] }, new Map([["image", "u1"], ["refs.0", "u2"]]));
 * // => { image: "u1", endImage: undefined, imageRefs: [], audioRefs: ["u2"], videoRefs: [] }
 * ```
 */
function splitUrls(request: VideoRequest, urlBySelector: ReadonlyMap<string, string>): InputUrls {
  // One list per ref kind; a ref of unknown kind goes with the images.
  const urlOf = (selector: string): string => urlBySelector.get(selector) ?? "";
  const imageUrls: string[] = [];
  const audioUrls: string[] = [];
  const videoUrls: string[] = [];
  const lists: Record<ReferenceKind, string[]> = {
    image: imageUrls,
    audio: audioUrls,
    video: videoUrls,
    unknown: imageUrls
  };

  // Each ref's URL into the list of its kind, in request order.
  for (const [index, ref] of (request.refs ?? []).entries()) {
    lists[referenceKindOf(ref)].push(urlOf(`refs.${index}`));
  }

  // The frames, then the three ref lists.
  const endImage = request.endImage === undefined ? undefined : urlOf("endImage");
  return {
    image: urlOf("image"),
    endImage,
    imageRefs: imageUrls,
    audioRefs: audioUrls,
    videoRefs: videoUrls
  };
}

/**
 * Makes every input readable by apimodels: the plain inputs as https
 * uploads, the named ones as `asset://` ids.
 *
 * @param ctx - Plugin context.
 * @param request - The validated request.
 * @param selectors - The inputs named in `params.assets`.
 * @param namedFiles - Their files, already checked to be images.
 * @param options - Key and caller signal.
 * @returns The input URLs, and the USD of the new registrations.
 */
async function resolveInputUrls(
  ctx: ApimodelsContext,
  request: VideoRequest,
  selectors: readonly string[],
  namedFiles: readonly VideoFile[],
  options: UploadOptions
): Promise<{ urls: InputUrls; assetUsd: number }> {
  // Upload the inputs the request does not name, then resolve the named ones.
  const named = new Set(selectors);
  const plain = listInputs(request).filter(input => !named.has(input.selector));
  const uploaded = await uploadFiles(
    ctx,
    plain.map(input => input.file),
    options
  );
  const assets = await resolveAssets(ctx, namedFiles, options);

  // One URL per selector, then split into the body's fields.
  const urlBySelector = new Map<string, string>();
  for (const [index, input] of plain.entries()) {
    urlBySelector.set(input.selector, uploaded[index] ?? "");
  }
  for (const [index, selector] of selectors.entries()) {
    urlBySelector.set(selector, assets.urls[index] ?? "");
  }
  return { urls: splitUrls(request, urlBySelector), assetUsd: assets.assetUsd };
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
function staleAssetError(
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
function taskFailure(
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
 * POSTs the task and returns its id. A stale asset id is dropped and thrown
 * retryable (terminal the second time); a task that failed at once is
 * classified like a failed poll.
 *
 * @param ctx - Plugin context.
 * @param staleSeen - Request keys already answered stale in this process.
 * @param submission - Model, request, input URLs and key.
 * @returns The task id.
 * @throws {TerminalProviderError} When the response has no task id.
 */
async function postTask(
  ctx: ApimodelsContext,
  staleSeen: Set<string>,
  submission: Submission
): Promise<string> {
  // No caller signal: once sent, the POST runs to the end so a billed task keeps its id.
  const { model, request, urls, apiKey } = submission;
  let data: unknown;
  try {
    data = await apiData(
      {
        url: `${ctx.config.baseUrl}/video/generations`,
        method: "POST",
        apiKey,
        json: buildBody(model, request, urls),
        timeoutMs: ctx.config.timeoutMs,
        redact: [request.prompt]
      },
      "submit response"
    );
  } catch (error) {
    const stale = isStaleAssetRejection(error)
      ? staleAssetError(ctx, staleSeen, request, apiKey)
      : undefined;
    throw stale ?? error;
  }

  // The state is the truth: a task that failed at once is read like a failed poll.
  const task = readTask(data);
  if (task.state === FAILED) throw taskFailure(ctx, staleSeen, task, request, apiKey);
  if (task.taskId === undefined || task.taskId === "") {
    throw new TerminalProviderError(
      "[ai] apimodels returned an incomplete submit response.\n  Expected data.taskId; check the apimodels API for a change.",
      BAD_REQUEST
    );
  }
  return task.taskId;
}

/**
 * Validates the request, uploads and resolves its inputs, and POSTs the
 * task. An abort stops the uploads; once the POST is sent it runs to the end.
 *
 * @param ctx - Plugin context.
 * @param staleSeen - Request keys already answered stale in this process.
 * @param request - The resolved request.
 * @param signal - Caller abort signal.
 * @returns The opaque job id.
 */
async function submitJob(
  ctx: ApimodelsContext,
  staleSeen: Set<string>,
  request: VideoRequest,
  signal: AbortSignal | undefined
): Promise<{ jobId: string }> {
  // Refuse what the model or params.assets cannot take, then read the key, before any upload.
  const model = resolveModel(request.model);
  checkRequest(model, request);
  const selectors = readAssetSelectors(request);
  const namedFiles = selectAssetFiles(request, selectors);
  const apiKey = resolveApiKey(ctx);
  if (request.negative !== undefined) {
    ctx.log.debug("apimodels:negative:ignored", { model: model.alias });
  }

  // Upload the plain inputs and turn the named ones into asset ids.
  const { urls, assetUsd } = await resolveInputUrls(ctx, request, selectors, namedFiles, {
    apiKey,
    signal
  });

  // Once the POST is sent apimodels may bill it: an abort now would lose the task id.
  signal?.throwIfAborted();
  const taskId = await postTask(ctx, staleSeen, { model, request, urls, apiKey });
  ctx.log.info("apimodels:video:submitted", { model: model.alias, taskId });
  return { jobId: encodeJobId({ taskId, model: model.alias, assetUsd }) };
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
 * submits anew; another
 * 4xx is thrown as a retryable 503 (poll again, the clip is paid for); any
 * other failure is thrown as is.
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
async function pollJob(
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

/**
 * Creates the apimodels video handler registered under `("video",
 * "apimodels")`. The handler keeps the request keys answered stale in this
 * process, so a stale asset gets one re-registration per request, the same
 * in `submit` and `poll`.
 *
 * @param ctx - Plugin context (config, state, env, log, journal).
 * @returns The handler: estimate, submit and poll.
 */
export function createVideoHandler(ctx: ApimodelsContext): ApimodelsVideoHandler {
  const staleSeen = new Set<string>();
  return {
    estimate: (request: EstimateRequest): { usd: number } => ({ usd: estimateUsd(ctx, request) }),
    submit: (request: VideoRequest, opts: { signal?: AbortSignal }): Promise<{ jobId: string }> =>
      submitJob(ctx, staleSeen, request, opts.signal),
    poll: (
      jobId: string,
      request: VideoRequest,
      opts: { signal?: AbortSignal }
    ): Promise<VideoJobPoll> => pollJob(ctx, staleSeen, jobId, request, opts.signal)
  };
}
