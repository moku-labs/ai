/**
 * @file fal upscale handler — estimate, execute, submit and poll over the
 * generic queue. The request is validated and priced before the key is read;
 * the source video goes to fal storage first (never a data URI), and the
 * upload and the result download run under `config.jobTimeoutMs`, not the
 * 60 s per-request limit. The queue POST carries no caller signal. No
 * fallback between models.
 */
import type {
  UpscaleEstimateRequest,
  UpscaleHandler,
  UpscaleJobPoll,
  UpscaleRequest,
  UpscaleResult
} from "../../upscale/contract";
import { readField, readString, resolveApiKey } from "../client/http";
import type { FalJob } from "../client/queue";
import {
  downloadFile,
  encodeJobId,
  fetchJobResult,
  mimeFromUrl,
  pollQueueJob,
  runQueueJob,
  submitJob
} from "../client/queue";
import { uploadPublic } from "../client/upload";
import type { RequestLog } from "../log";
import { createRequestLog, withRequestLog } from "../log";
import { resolvePrices } from "../prices";
import type { FalContext } from "../types";
import type { ResolvedUpscaleModel } from "./models";
import { checkUpscaleEstimate, checkUpscaleRequest } from "./models";
import { upscalePriceOf } from "./prices";

/**
 * Everything checked before any I/O: the model, the request, the body and the cost.
 */
export type UpscalePlan = {
  /** The resolved catalog row. */
  model: ResolvedUpscaleModel;
  /** The validated request. */
  request: UpscaleRequest;
  /** The posted body without `video_url`, which is added once the video is uploaded. */
  body: Record<string, unknown>;
  /** USD for this video. */
  costUsd: number;
};

/** Log event for a failed upscale job. */
const FAILED_EVENT = "fal:upscale:failed";

/** MIME type when neither fal, the download nor the URL names one. */
const DEFAULT_MIME = "video/mp4";

/** MIME types by output file extension. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm"
};

/**
 * The context a video transfer runs under: the same plugin context with
 * `timeoutMs` raised to `jobTimeoutMs`. A minute of 1080×1920 video does not
 * fit the 60 s total limit of one request. State and log are shared, so the
 * upload cache still dedupes by content.
 *
 * @param ctx - Plugin context.
 * @returns A context view for the upload.
 */
function transferContext(ctx: FalContext): FalContext {
  return { ...ctx, config: { ...ctx.config, timeoutMs: ctx.config.jobTimeoutMs } };
}

/**
 * Prices an estimate request without I/O: validation, model and cost. No file is read.
 *
 * @param ctx - Plugin context (price table).
 * @param request - The upscale request; `video` may still be a reference.
 * @returns USD for this video.
 * @throws {TerminalProviderError} A 400 for an invalid request, an unknown model or a missing price.
 */
function estimateUpscale(ctx: FalContext, request: UpscaleEstimateRequest): number {
  const { model } = checkUpscaleEstimate(request);
  return upscalePriceOf(resolvePrices(ctx), model.alias, request.seconds);
}

/**
 * Plans a request without I/O: validation, model, body and price.
 *
 * @param ctx - Plugin context (price table).
 * @param request - The upscale request with its resolved video.
 * @returns The plan.
 * @throws {TerminalProviderError} A 400 for an invalid request, an unknown model or a missing price.
 */
export function planUpscale(ctx: FalContext, request: UpscaleRequest): UpscalePlan {
  const checked = checkUpscaleRequest(request);
  const { model } = checked;
  const costUsd = upscalePriceOf(resolvePrices(ctx), model.alias, request.seconds);
  return { model, request: checked.request, body: model.body(checked.request), costUsd };
}

/**
 * Reads the key, uploads the video and queues the job, writing the request log
 * line around the POST.
 *
 * @param ctx - Plugin context.
 * @param requestLog - The request log, or undefined when off.
 * @param plan - The plan.
 * @param signal - Caller abort signal; reaches the upload and is checked once before the POST.
 * @returns The opaque job id.
 * @throws {Error} A missing key, a failed upload (there is no data-URI fallback), the abort, or any queue error.
 */
async function submitUpscale(
  ctx: FalContext,
  requestLog: RequestLog | undefined,
  plan: UpscalePlan,
  signal: AbortSignal | undefined
): Promise<{ jobId: string }> {
  const apiKey = resolveApiKey(ctx);
  const { model, request } = plan;

  // A minute of video is no data URI: it goes to storage, and a failed upload fails the submit.
  const videoUrl = await uploadPublic(transferContext(ctx), request.video, { apiKey, signal });
  const body = { ...plan.body, video_url: videoUrl };

  // Once the POST is sent fal may bill it: an abort now would lose the job id, so it runs to the end.
  signal?.throwIfAborted();
  const entry = {
    task: "upscale" as const,
    model: model.alias,
    endpoint: model.endpoint,
    prompt: "",
    body,
    files: [request.video]
  };
  const job = await withRequestLog(
    requestLog,
    entry,
    () => submitJob(ctx, model.endpoint, body, { apiKey, timeoutMs: ctx.config.timeoutMs }),
    submitted => submitted.requestId
  );

  ctx.log.info("fal:upscale:submitted", {
    model: model.alias,
    endpoint: model.endpoint,
    requestId: job.requestId,
    seconds: request.seconds,
    factor: request.factor
  });
  return { jobId: encodeJobId(job) };
}

/**
 * Collects a completed job: result body, `video.url`, CDN download (no key).
 * The MIME type is fal's `content_type`, else the download header, else the
 * URL extension, else `video/mp4`. The download runs under `config.jobTimeoutMs`.
 *
 * @param ctx - Plugin context.
 * @param job - The job.
 * @param plan - The plan of the request the job was submitted with.
 * @param apiKey - The fal key (result call only).
 * @param signal - Caller abort signal.
 * @returns The upscale result.
 * @throws {Error} A plain error when the result has no `video.url`; any call error.
 */
async function collectUpscale(
  ctx: FalContext,
  job: FalJob,
  plan: UpscalePlan,
  apiKey: string,
  signal: AbortSignal | undefined
): Promise<UpscaleResult> {
  // The result body names the video file; without video.url there is nothing to download.
  const { timeoutMs, jobTimeoutMs } = ctx.config;
  const body = await fetchJobResult(job, { apiKey, timeoutMs, signal });
  const video = readField(body, "video");
  const url = readString(video, "url");
  if (url === undefined) {
    throw new Error(
      "[ai] fal returned an incomplete upscale result.\n  Expected video.url in the response."
    );
  }

  // The CDN download goes without the key, under the long transfer limit.
  const { bytes, contentType } = await downloadFile(url, { timeoutMs: jobTimeoutMs, signal });
  const mimeType =
    readString(video, "content_type") ??
    contentType ??
    mimeFromUrl(url, MIME_BY_EXTENSION) ??
    DEFAULT_MIME;
  ctx.log.info("fal:upscale:done", { requestId: job.requestId, bytes: bytes.length });

  const meta = {
    model: plan.model.alias,
    endpoint: job.endpoint,
    requestId: job.requestId,
    seconds: plan.request.seconds,
    factor: plan.request.factor
  };
  return { video: bytes, mimeType, costUsd: plan.costUsd, meta };
}

/**
 * Creates the fal upscale handler registered under `("upscale", "fal")`.
 * `estimate` touches no network and needs no key. `submit` + `poll` is the
 * job form the runner journals; `execute` (the `app.upscale` facade) submits
 * and waits in process, every `config.pollIntervalMs`, at most `config.jobTimeoutMs`.
 *
 * @param ctx - Plugin context (config, state, env, log).
 * @returns The handler: estimate, execute, submit and poll.
 */
export function createUpscaleHandler(ctx: FalContext): Required<UpscaleHandler> {
  const requestLog = createRequestLog(ctx);
  const collect =
    (plan: UpscalePlan, signal: AbortSignal | undefined) =>
    (job: FalJob, apiKey: string): Promise<UpscaleResult> =>
      collectUpscale(ctx, job, plan, apiKey, signal);

  return {
    estimate: (request: UpscaleEstimateRequest): { usd: number } => ({
      usd: estimateUpscale(ctx, request)
    }),
    // Async arrows: a plan error rejects the promise instead of throwing synchronously.
    submit: async (
      request: UpscaleRequest,
      opts: { signal?: AbortSignal }
    ): Promise<{ jobId: string }> =>
      submitUpscale(ctx, requestLog, planUpscale(ctx, request), opts.signal),
    poll: async (
      jobId: string,
      request: UpscaleRequest,
      opts: { signal?: AbortSignal }
    ): Promise<UpscaleJobPoll> =>
      pollQueueJob(
        ctx,
        jobId,
        opts.signal,
        FAILED_EVENT,
        collect(planUpscale(ctx, request), opts.signal)
      ),
    execute: async (
      request: UpscaleRequest,
      opts: { signal?: AbortSignal }
    ): Promise<UpscaleResult> => {
      const plan = planUpscale(ctx, request);
      const { jobId } = await submitUpscale(ctx, requestLog, plan, opts.signal);
      return runQueueJob(ctx, jobId, opts.signal, collect(plan, opts.signal));
    }
  };
}
