/**
 * @file fal music handler — estimate, execute, submit and poll over the
 * generic queue. The request is validated and priced before the key is read;
 * the queue POST carries no caller signal. No fallback between models.
 */
import type { MusicHandler, MusicJobPoll, MusicRequest, MusicResult } from "../../music/contract";
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
import type { RequestLog } from "../log";
import { createRequestLog, withRequestLog } from "../log";
import { resolvePrices } from "../prices";
import type { FalContext } from "../types";
import type { ResolvedMusicModel } from "./models";
import { checkMusicRequest } from "./models";
import { musicPriceOf } from "./prices";

/**
 * Everything checked before any I/O: the model, the request, the body and the cost.
 *
 * @example
 * ```ts
 * planMusic(ctx, { prompt: "tense synth", model: "elevenlabs-music-v2.5", lengthMs: 65_000 }).costUsd; // => 1.6
 * ```
 */
export type MusicPlan = {
  /** The resolved catalog row. */
  model: ResolvedMusicModel;
  /** The validated request. */
  request: MusicRequest;
  /** The posted body. */
  body: Record<string, unknown>;
  /** USD for this track. */
  costUsd: number;
};

/** Log event for a failed music job. */
const FAILED_EVENT = "fal:music:failed";

/** MIME type when neither fal, the download nor the URL names one. */
const DEFAULT_MIME = "audio/mpeg";

/** MIME types by output file extension. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/ogg"
};

/**
 * Plans a request without I/O: validation, model, body and price.
 *
 * @param ctx - Plugin context (price table).
 * @param request - The music request.
 * @returns The plan.
 * @throws {TerminalProviderError} A 400 for an invalid request, an unknown model or a missing price.
 */
export function planMusic(ctx: FalContext, request: MusicRequest): MusicPlan {
  const checked = checkMusicRequest(request);
  const { model } = checked;
  const costUsd = musicPriceOf(resolvePrices(ctx), model.alias, model.billing, request.lengthMs);
  return { model, request: checked.request, body: model.body(checked.request), costUsd };
}

/**
 * Reads the key and queues the job, writing the request log line around the POST.
 *
 * @param ctx - Plugin context.
 * @param requestLog - The request log, or undefined when off.
 * @param plan - The plan.
 * @param signal - Caller abort signal; checked once before the POST.
 * @returns The opaque job id.
 */
async function submitMusic(
  ctx: FalContext,
  requestLog: RequestLog | undefined,
  plan: MusicPlan,
  signal: AbortSignal | undefined
): Promise<{ jobId: string }> {
  const apiKey = resolveApiKey(ctx);

  // Once the POST is sent fal may bill it: an abort now would lose the job id, so it runs to the end.
  signal?.throwIfAborted();
  const { model, request, body } = plan;
  const entry = {
    task: "music" as const,
    model: model.alias,
    endpoint: model.endpoint,
    prompt: request.prompt,
    body,
    files: []
  };
  const job = await withRequestLog(
    requestLog,
    entry,
    () => submitJob(ctx, model.endpoint, body, { apiKey, timeoutMs: ctx.config.timeoutMs }),
    submitted => submitted.requestId
  );

  ctx.log.info("fal:music:submitted", {
    model: model.alias,
    endpoint: model.endpoint,
    requestId: job.requestId,
    lengthMs: request.lengthMs
  });
  return { jobId: encodeJobId(job) };
}

/**
 * Collects a completed job: result body, `audio.url`, CDN download (no key).
 * The MIME type is fal's `content_type`, else the download header, else the
 * URL extension, else `audio/mpeg`.
 *
 * @param ctx - Plugin context.
 * @param job - The job.
 * @param plan - The plan of the request the job was submitted with.
 * @param apiKey - The fal key (result call only).
 * @param signal - Caller abort signal.
 * @returns The music result.
 * @throws {Error} A plain error when the result has no `audio.url`; any call error.
 */
async function collectMusic(
  ctx: FalContext,
  job: FalJob,
  plan: MusicPlan,
  apiKey: string,
  signal: AbortSignal | undefined
): Promise<MusicResult> {
  const { timeoutMs } = ctx.config;
  const body = await fetchJobResult(job, { apiKey, timeoutMs, signal });
  const audio = readField(body, "audio");
  const url = readString(audio, "url");
  if (url === undefined) {
    throw new Error(
      "[ai] fal returned an incomplete music result.\n  Expected audio.url in the response."
    );
  }

  // The CDN download goes without the key.
  const { bytes, contentType } = await downloadFile(url, { timeoutMs, signal });
  const mimeType =
    readString(audio, "content_type") ??
    contentType ??
    mimeFromUrl(url, MIME_BY_EXTENSION) ??
    DEFAULT_MIME;
  ctx.log.info("fal:music:done", { requestId: job.requestId, bytes: bytes.length });

  const meta = {
    model: plan.model.alias,
    endpoint: job.endpoint,
    requestId: job.requestId,
    lengthMs: plan.request.lengthMs
  };
  return { audio: bytes, mimeType, costUsd: plan.costUsd, meta };
}

/**
 * Creates the fal music handler registered under `("music", "fal")`.
 * `estimate` touches no network and needs no key. `submit` + `poll` is the
 * job form the runner journals; `execute` (the `app.music` facade) submits
 * and waits in process, every `config.pollMs`, at most `config.jobTimeoutMs`.
 *
 * @param ctx - Plugin context (config, state, env, log).
 * @returns The handler: estimate, execute, submit and poll.
 */
export function createMusicHandler(ctx: FalContext): Required<MusicHandler> {
  const requestLog = createRequestLog(ctx);
  const collect =
    (plan: MusicPlan, signal: AbortSignal | undefined) =>
    (job: FalJob, apiKey: string): Promise<MusicResult> =>
      collectMusic(ctx, job, plan, apiKey, signal);

  return {
    estimate: (request: MusicRequest): { usd: number } => ({
      usd: planMusic(ctx, request).costUsd
    }),
    // Async arrows: a plan error rejects the promise instead of throwing synchronously.
    submit: async (
      request: MusicRequest,
      opts: { signal?: AbortSignal }
    ): Promise<{ jobId: string }> =>
      submitMusic(ctx, requestLog, planMusic(ctx, request), opts.signal),
    poll: async (
      jobId: string,
      request: MusicRequest,
      opts: { signal?: AbortSignal }
    ): Promise<MusicJobPoll> =>
      pollQueueJob(
        ctx,
        jobId,
        opts.signal,
        FAILED_EVENT,
        collect(planMusic(ctx, request), opts.signal)
      ),
    execute: async (
      request: MusicRequest,
      opts: { signal?: AbortSignal }
    ): Promise<MusicResult> => {
      const plan = planMusic(ctx, request);
      const { jobId } = await submitMusic(ctx, requestLog, plan, opts.signal);
      return runQueueJob(ctx, jobId, opts.signal, collect(plan, opts.signal));
    }
  };
}
