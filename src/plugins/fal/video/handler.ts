/**
 * @file fal video handler — implements the task-owned contract
 * (`../../video/contract.ts`) over the fal queue API. `submit` uploads the
 * inputs and queues the job; `poll` reads the status once and, when the job
 * is done, fetches the result and downloads the clip. There is no `execute`:
 * the runner and the `video` facade both drive `submit` + `poll`. Cost comes from the shared price table
 * (`./prices.ts`), so estimate and actual cost always agree.
 */
import { ASSET_MIME } from "../../asset/contract";
import type {
  EstimateRequest,
  VideoFile,
  VideoHandler,
  VideoJobPoll,
  VideoRequest
} from "../../video/contract";
import type { FalResponse } from "../client/http";
import {
  falFetch,
  jobFailure,
  parseJson,
  readApiKey,
  readString,
  redacted,
  resolveApiKey
} from "../client/http";
import { isKeyRejection, pollKeyError } from "../client/queue";
import type { FalContext } from "../types";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "../types";
import type { FalJob } from "./job";
import {
  decodeJobId,
  encodeJobId,
  hasJobError,
  parseSubmitResponse,
  parseVideoResult
} from "./job";
import type { ResolvedFalModel, SplitReferences } from "./models";
import { buildFalBody, endFrameAliases, requestSeconds, resolveFalModel } from "./models";
import { videoCostUsd } from "./prices";
import { uploadInputs } from "./upload";

/** The fal video handler: the async form of the contract (no `execute`). */
export type FalVideoHandler = Required<Pick<VideoHandler, "estimate" | "submit" | "poll">>;

/** Status values while fal is still working on a job. */
const PENDING_STATUSES: ReadonlySet<string> = new Set(["IN_QUEUE", "IN_PROGRESS"]);

/** Status of a job fal has finished. */
const COMPLETED_STATUS = "COMPLETED";

/** MIME type used when fal reports none. */
const DEFAULT_VIDEO_MIME = "video/mp4";

/** The one pending poll value. */
const PENDING: VideoJobPoll = { state: "pending" };

/** Log event for a job that ended with an error. */
const FAILED_EVENT = "fal:video:failed";

/** fal's status for a job it rejected (validation or content policy) when the result is read. */
const UNPROCESSABLE = 422;

/**
 * fal's other status for a job it rejected when the result (or the clip) is
 * read: a verdict like 422, not a lost result, so polling again never succeeds.
 */
const BAD_REQUEST = 400;

/** Result statuses that are fal's verdict on the job, not a failure to read it. */
const JOB_VERDICT_STATUSES: ReadonlySet<number> = new Set([BAD_REQUEST, UNPROCESSABLE]);

/** Status carried by a result that could not be read, so the runner classifies it retryable (5xx). */
const RETRY_STATUS = 503;

/**
 * Returns the request's first frame; every current alias needs one.
 *
 * @param model - The resolved catalog row.
 * @param request - The video request.
 * @returns The first frame.
 * @throws {Error} A plain (terminal) two-line error when there is no image.
 * @example
 * ```ts
 * requireImage(resolveFalModel("minimax-h3"), { model: "minimax-h3", prompt: "p" });
 * // throws: '[ai] fal model "minimax-h3" needs an image.\n  Set input.image to a $ref or $file.'
 * ```
 */
function requireImage(model: ResolvedFalModel, request: VideoRequest): VideoFile {
  if (request.image === undefined) {
    throw new Error(
      `[ai] fal model "${model.alias}" needs an image.\n  Set input.image to a $ref or $file.`
    );
  }
  return request.image;
}

/**
 * Refuses an end frame on a model that takes none, before any upload.
 *
 * @param model - The resolved catalog row.
 * @param request - The video request; its end frame may still be an unresolved `$ref`.
 * @throws {Error} A plain (terminal) two-line error listing the models that take an end frame.
 * @example
 * ```ts
 * requireEndFrameSupport(resolveFalModel("veo-3.1-fast"), { model: "veo-3.1-fast", prompt: "p", endImage: { path: "end.png", mimeType: "image/png", hash: "h" } });
 * // throws: '[ai] fal model "veo-3.1-fast" takes no end frame.\n  Remove input.endImage, or use a model that takes one: seedance-2.5, minimax-h3, minimax-h3-max-i2v, kling-3-pro, seedance-2.0-mini, vidu-q3, gemini-omni-1.1-flash.'
 * ```
 */
function requireEndFrameSupport(
  model: ResolvedFalModel,
  request: Pick<EstimateRequest, "endImage">
): void {
  if (request.endImage === undefined || model.endFrame) return;

  throw new Error(
    `[ai] fal model "${model.alias}" takes no end frame.\n  Remove input.endImage, or use a model that takes one: ${endFrameAliases().join(", ")}.`
  );
}

/**
 * Refuses a registered asset as the first frame, the end frame or a ref,
 * before any upload. fal takes image URLs only; an asset's bytes are its
 * record's JSON, which fal would reject late as a broken image.
 *
 * @param request - The video request, with its inputs resolved.
 * @throws {TerminalProviderError} A two-line HTTP 400 error naming an asset provider.
 * @example
 * ```ts
 * rejectAssetReferences({ model: "minimax-h3", prompt: "p", image: { path: "mira.json", mimeType: ASSET_MIME, hash: "h" } });
 * // throws: '[ai] fal cannot use asset references.\n  Use provider ark (or another asset provider) for items that $ref an asset.'
 * ```
 */
function rejectAssetReferences(request: VideoRequest): void {
  const inputs = [request.image, request.endImage, ...(request.refs ?? [])];
  const hasAsset = inputs.some(file => file?.mimeType === ASSET_MIME);
  if (!hasAsset) return;

  throw new TerminalProviderError(
    "[ai] fal cannot use asset references.\n  Use provider ark (or another asset provider) for items that $ref an asset.",
    BAD_REQUEST
  );
}

/**
 * Whether a ref is an audio ref.
 *
 * @param file - The ref.
 * @returns True for an `audio/*` MIME type.
 * @example
 * ```ts
 * isAudioReference({ path: "v.mp3", mimeType: "audio/mpeg", hash: "h" }); // => true
 * ```
 */
function isAudioReference(file: VideoFile): boolean {
  return file.mimeType.startsWith("audio/");
}

/**
 * Whether a ref is a video ref.
 *
 * @param file - The ref.
 * @returns True for a `video/*` MIME type.
 * @example
 * ```ts
 * isVideoReference({ path: "tail.mp4", mimeType: "video/mp4", hash: "h" }); // => true
 * ```
 */
function isVideoReference(file: VideoFile): boolean {
  return file.mimeType.startsWith("video/");
}

/**
 * Whether a ref is an image ref: neither audio nor video.
 *
 * @param file - The ref.
 * @returns True for every other MIME type.
 * @example
 * ```ts
 * isImageReference({ path: "face.png", mimeType: "image/png", hash: "h" }); // => true
 * ```
 */
function isImageReference(file: VideoFile): boolean {
  return !isAudioReference(file) && !isVideoReference(file);
}

/**
 * The two-line error for refs over a model's limit.
 *
 * @param model - The resolved catalog row.
 * @param kind - What is over the limit.
 * @param max - The model's limit.
 * @param given - How many the request has.
 * @returns A plain (terminal) error.
 * @example
 * ```ts
 * tooManyReferencesError(resolveFalModel("kling-o3-ref"), "reference images", 4, 6).message;
 * // => '[ai] fal model "kling-o3-ref" takes at most 4 reference images, got 6.\n  Remove refs from input.refs, or use a model that takes more.'
 * ```
 */
function tooManyReferencesError(
  model: ResolvedFalModel,
  kind: "reference images" | "reference audio files" | "video references",
  max: number,
  given: number
): Error {
  const limit =
    max === 0 ? `takes no ${kind.replace(" files", "")}` : `takes at most ${max} ${kind}`;
  return new Error(
    `[ai] fal model "${model.alias}" ${limit}, got ${given}.\n  Remove refs from input.refs, or use a model that takes more.`
  );
}

/**
 * Splits the refs into images, audio and videos and checks each against the
 * model's limit. Nothing is dropped: a request over a limit fails before any
 * upload.
 *
 * @param model - The resolved catalog row.
 * @param references - The request's refs.
 * @returns Image refs, audio refs and video refs, each in request order.
 * @throws {Error} A plain (terminal) two-line error when a limit is exceeded.
 * @example
 * ```ts
 * splitReferences(resolveFalModel("kling-o3-ref"), [{ path: "t.mp4", mimeType: "video/mp4", hash: "h" }]);
 * // throws: '[ai] fal model "kling-o3-ref" takes no video references, got 1.\n  Remove refs from input.refs, or use a model that takes more.'
 * ```
 */
export function splitReferences(
  model: ResolvedFalModel,
  references: readonly VideoFile[]
): SplitReferences {
  // Split by MIME, keeping request order inside each group
  const images = references.filter(file => isImageReference(file));
  const audio = references.filter(file => isAudioReference(file));
  const videos = references.filter(file => isVideoReference(file));

  // Check each group against the catalog row before any upload
  if (images.length > model.maxRefs) {
    throw tooManyReferencesError(model, "reference images", model.maxRefs, images.length);
  }
  if (audio.length > model.maxAudioRefs) {
    throw tooManyReferencesError(model, "reference audio files", model.maxAudioRefs, audio.length);
  }
  if (videos.length > model.maxVideoRefs) {
    throw tooManyReferencesError(model, "video references", model.maxVideoRefs, videos.length);
  }
  return { images, audio, videos };
}

/**
 * Uploads the inputs, POSTs the mapped body to the model's endpoint, and
 * encodes fal's queue answer as the job id.
 *
 * @param ctx - Plugin context.
 * @param request - The video request.
 * @param signal - Caller abort signal.
 * @returns The opaque job id.
 */
async function submitJob(
  ctx: FalContext,
  request: VideoRequest,
  signal: AbortSignal | undefined
): Promise<{ jobId: string }> {
  // Refuse what the model cannot take and read the key, before any upload.
  const model = resolveFalModel(request.model);
  rejectAssetReferences(request);
  const image = requireImage(model, request);
  requireEndFrameSupport(model, request);
  const apiKey = resolveApiKey(ctx);

  // Check the refs against the model's limits, then upload every input.
  const references = splitReferences(model, request.refs ?? []);
  const urls = await uploadInputs(ctx, image, references, { apiKey, signal }, request.endImage);

  // Once the POST is sent fal may bill it: an abort now would lose the job id, so it runs to the end.
  signal?.throwIfAborted();
  const response = await falFetch({
    url: `${ctx.config.queueUrl}/${model.endpoint}`,
    method: "POST",
    apiKey,
    json: buildFalBody(model, request, urls),
    timeoutMs: ctx.config.timeoutMs
  });

  // Keep fal's queue answer as the opaque job id.
  const job = parseSubmitResponse(parseJson(response, "submit response"), model.endpoint);
  ctx.log.info("fal:video:submitted", {
    model: model.alias,
    endpoint: job.endpoint,
    requestId: job.requestId
  });
  return { jobId: encodeJobId(job) };
}

/**
 * Whether a result or download failure is fal's verdict on the job: a
 * content-policy flag, or a terminal 400 / 422.
 *
 * @param error - What the result or download call threw.
 * @returns True when the job should end as `failed`.
 * @example
 * ```ts
 * isJobVerdict(new TerminalProviderError("[ai] fal rejected the request (HTTP 400).", 400)); // => true
 * ```
 */
function isJobVerdict(error: unknown): error is FlaggedProviderError | TerminalProviderError {
  if (error instanceof FlaggedProviderError) return true;
  return error instanceof TerminalProviderError && JOB_VERDICT_STATUSES.has(error.status);
}

/**
 * Fetches a finished job's result and downloads the clip. A content-policy
 * flag or a 400 / 422 on the result or the download is fal's verdict and
 * becomes `failed`. Any other failure (another 4xx, 5xx, network, timeout)
 * is thrown as retryable: the clip exists and is paid for, so the runner
 * keeps polling and the job stays adoptable instead of being paid for again.
 *
 * @param ctx - Plugin context.
 * @param job - The job.
 * @param request - The request the job was submitted with.
 * @param apiKey - The fal key (result call only; the CDN download goes without it).
 * @param signal - Caller abort signal.
 * @returns A done or failed poll.
 */
async function fetchResult(
  ctx: FalContext,
  job: FalJob,
  request: VideoRequest,
  apiKey: string,
  signal: AbortSignal | undefined
): Promise<VideoJobPoll> {
  const timeoutMs = ctx.config.timeoutMs;
  try {
    const result = await falFetch({
      url: job.responseUrl,
      method: "GET",
      apiKey,
      timeoutMs,
      signal
    });
    const video = parseVideoResult(parseJson(result, "result"));
    const download = await falFetch({ url: video.url, method: "GET", timeoutMs, signal });

    ctx.log.info("fal:video:done", { requestId: job.requestId, bytes: download.body.length });
    return {
      state: "done",
      video: download.body,
      mimeType: video.contentType ?? DEFAULT_VIDEO_MIME,
      costUsd: videoCostUsd(ctx, request),
      meta: { endpoint: job.endpoint, requestId: job.requestId, seconds: requestSeconds(request) }
    };
  } catch (error) {
    if (!isJobVerdict(error)) throw asRetryable(ctx, job, error);
    ctx.log.warn(FAILED_EVENT, { requestId: job.requestId, ...redacted(error) });
    return { state: "failed", error };
  }
}

/**
 * Turns a terminal failure to read a finished job's result into a retryable
 * one (logged as `fal:result:unreadable`); every other error is returned as is.
 *
 * @param ctx - Plugin context (log).
 * @param job - The job.
 * @param error - What the result or download call threw.
 * @returns The error to throw.
 */
function asRetryable(ctx: FalContext, job: FalJob, error: unknown): unknown {
  if (!(error instanceof TerminalProviderError)) return error;

  ctx.log.warn("fal:result:unreadable", { requestId: job.requestId, status: error.status });
  return new RetryableProviderError(
    `[ai] fal finished the job but its result could not be read (HTTP ${error.status}).\n  Poll the job again; the runner does this on its own.`,
    { status: RETRY_STATUS }
  );
}

/**
 * Polls a job once: pending, failed with fal's classified job error, or
 * done with the downloaded clip. A key missing or refused (401/403) on the
 * status call is thrown as a plain error, so the runner marks the job
 * expired and a later run adopts the same job.
 *
 * @param ctx - Plugin context.
 * @param jobId - The id `submit` returned.
 * @param request - The request the job was submitted with.
 * @param signal - Caller abort signal.
 * @returns The poll result.
 */
async function pollJob(
  ctx: FalContext,
  jobId: string,
  request: VideoRequest,
  signal: AbortSignal | undefined
): Promise<VideoJobPoll> {
  // Without a valid key the job stays adoptable: the poll must not read as failed.
  const job = decodeJobId(jobId);
  const apiKey = readApiKey(ctx);
  if (apiKey === undefined) throw pollKeyError(ctx.config.apiKeyEnv);

  // Read the job status once; a refused key keeps the job adoptable too.
  let response: FalResponse;
  try {
    response = await falFetch({
      url: job.statusUrl,
      method: "GET",
      apiKey,
      timeoutMs: ctx.config.timeoutMs,
      signal
    });
  } catch (error) {
    if (isKeyRejection(error)) throw pollKeyError(ctx.config.apiKeyEnv);
    throw error;
  }

  // Still working, or a status we do not know: stay pending.
  const body = parseJson(response, "status response");
  const status = readString(body, "status");
  const isPending = status !== undefined && PENDING_STATUSES.has(status);
  if (isPending) return PENDING;
  if (status !== COMPLETED_STATUS) {
    ctx.log.warn("fal:poll:unknown-status", { requestId: job.requestId, status });
    return PENDING;
  }

  // Done: fail on fal's job error, else fetch the clip.
  if (hasJobError(body)) {
    const error = jobFailure(body);
    ctx.log.warn(FAILED_EVENT, { requestId: job.requestId, ...redacted(error) });
    return { state: "failed", error };
  }
  return fetchResult(ctx, job, request, apiKey, signal);
}

/**
 * Creates the fal video handler registered under `("video", "fal")`.
 * `estimate` touches no network: it refuses an end frame the model cannot
 * take, with the same error as `submit`, then prices the request. `submit`
 * uploads the inputs and queues the job; an abort stops the uploads, but once
 * the queue POST is sent it runs to the end, so a billed job always returns
 * its id.
 *
 * @param ctx - Plugin context (config, state, env, log).
 * @returns The handler: estimate, submit and poll.
 */
export function createVideoHandler(ctx: FalContext): FalVideoHandler {
  return {
    estimate: (request: EstimateRequest): { usd: number } => {
      requireEndFrameSupport(resolveFalModel(request.model), request);
      return { usd: videoCostUsd(ctx, request) };
    },
    submit: (request: VideoRequest, opts: { signal?: AbortSignal }): Promise<{ jobId: string }> =>
      submitJob(ctx, request, opts.signal),
    poll: (
      jobId: string,
      request: VideoRequest,
      opts: { signal?: AbortSignal }
    ): Promise<VideoJobPoll> => pollJob(ctx, jobId, request, opts.signal)
  };
}
