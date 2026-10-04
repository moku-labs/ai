/**
 * @file fal sfx handler — estimate and execute over the generic queue. The
 * request is validated and priced before the key is read; the queue POST
 * carries no caller signal. The result must be mp3: any other format is a
 * terminal error and is never returned (D1).
 */
import type { SfxHandler, SfxRequest, SfxResult } from "../../sfx/contract";
import { readField, readString, resolveApiKey } from "../client/http";
import type { FalJob } from "../client/queue";
import {
  downloadFile,
  encodeJobId,
  fetchJobResult,
  mimeFromUrl,
  runQueueJob,
  submitJob
} from "../client/queue";
import { TerminalProviderError } from "../errors";
import type { RequestLog } from "../log";
import { createRequestLog, withRequestLog } from "../log";
import { resolvePrices } from "../prices";
import type { FalContext } from "../types";
import type { ResolvedSfxModel } from "./models";
import { checkSfxRequest } from "./models";
import { sfxPriceOf } from "./prices";

/**
 * Everything checked before any I/O: the model, the request, the body and the cost.
 *
 * @example
 * ```ts
 * planSfx(ctx, { prompt: "coin", model: "elevenlabs-sfx-v2", durationMs: 2500 }).costUsd; // => 0.006
 * ```
 */
export type SfxPlan = {
  /** The resolved catalog row. */
  model: ResolvedSfxModel;
  /** The validated request. */
  request: SfxRequest;
  /** The posted body. */
  body: Record<string, unknown>;
  /** USD for this clip; the model's longest clip when the request has no duration. */
  costUsd: number;
};

/** The one MIME type an sfx result may have. */
const MP3_MIME = "audio/mpeg";

/** MIME types that name mp3: the standard one and the common `audio/mp3` alias. */
const MP3_MIME_TYPES: ReadonlySet<string> = new Set([MP3_MIME, "audio/mp3"]);

/** MIME types by output file extension. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  mp3: MP3_MIME,
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/ogg"
};

/** Status of a result in a format the task does not take. */
const UNSUPPORTED_MEDIA_TYPE = 415;

/**
 * Plans a request without I/O: validation, model, body and price. Without
 * `durationMs` the price is the model's longest clip, an upper bound for the
 * budget gate.
 *
 * @param ctx - Plugin context (price table).
 * @param request - The sfx request.
 * @returns The plan.
 * @throws {TerminalProviderError} A 400 for an invalid request, an unknown model or a missing price.
 */
export function planSfx(ctx: FalContext, request: SfxRequest): SfxPlan {
  const checked = checkSfxRequest(request);
  const { model } = checked;
  const billedMs = request.durationMs ?? model.maxMs;
  const costUsd = sfxPriceOf(resolvePrices(ctx), model.alias, billedMs);
  return { model, request: checked.request, body: model.body(checked.request), costUsd };
}

/**
 * Whether a MIME type names mp3, ignoring case and parameters.
 *
 * @param mimeType - The MIME type of the result.
 * @returns True for `audio/mpeg` or `audio/mp3`.
 * @example
 * ```ts
 * isMp3("audio/mpeg; charset=binary"); // => true
 * ```
 */
function isMp3(mimeType: string): boolean {
  const essence = mimeType.split(";")[0] ?? "";
  return MP3_MIME_TYPES.has(essence.trim().toLowerCase());
}

/**
 * The duration as a field, when the request has one.
 *
 * @param durationMs - `SfxRequest.durationMs`.
 * @returns The field, or an empty object.
 * @example
 * ```ts
 * durationField(600); // => { durationMs: 600 }
 * ```
 */
function durationField(durationMs: number | undefined): { durationMs?: number } {
  return durationMs === undefined ? {} : { durationMs };
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
async function submitSfx(
  ctx: FalContext,
  requestLog: RequestLog | undefined,
  plan: SfxPlan,
  signal: AbortSignal | undefined
): Promise<{ jobId: string }> {
  const apiKey = resolveApiKey(ctx);

  // Once the POST is sent fal may bill it: an abort now would lose the job id, so it runs to the end.
  signal?.throwIfAborted();
  const { model, request, body } = plan;
  const entry = {
    task: "sfx" as const,
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

  ctx.log.info("fal:sfx:submitted", {
    model: model.alias,
    endpoint: model.endpoint,
    requestId: job.requestId,
    ...durationField(request.durationMs)
  });
  return { jobId: encodeJobId(job) };
}

/**
 * Collects a completed job: result body, `audio.url`, CDN download (no key).
 * The MIME type is fal's `content_type`, else the download header, else the
 * URL extension, else `audio/mpeg`; anything but mp3 is refused.
 *
 * @param ctx - Plugin context.
 * @param job - The job.
 * @param plan - The plan of the request the job was submitted with.
 * @param apiKey - The fal key (result call only).
 * @param signal - Caller abort signal.
 * @returns The sfx result, always `audio/mpeg`.
 * @throws {TerminalProviderError} A 415 when the result is not mp3.
 * @throws {Error} A plain error when the result has no `audio.url`; any call error.
 */
async function collectSfx(
  ctx: FalContext,
  job: FalJob,
  plan: SfxPlan,
  apiKey: string,
  signal: AbortSignal | undefined
): Promise<SfxResult> {
  // The result body names the audio file; without audio.url there is nothing to download.
  const { timeoutMs } = ctx.config;
  const body = await fetchJobResult(job, { apiKey, timeoutMs, signal });
  const audio = readField(body, "audio");
  const url = readString(audio, "url");
  if (url === undefined) {
    throw new Error(
      "[ai] fal returned an incomplete sfx result.\n  Expected audio.url in the response."
    );
  }

  // The CDN download goes without the key; the game engine reads mp3 only, so nothing else is returned.
  const { bytes, contentType } = await downloadFile(url, { timeoutMs, signal });
  const mimeType =
    readString(audio, "content_type") ??
    contentType ??
    mimeFromUrl(url, MIME_BY_EXTENSION) ??
    MP3_MIME;
  if (!isMp3(mimeType)) {
    throw new TerminalProviderError(
      `[ai] fal returned "${mimeType}" for sfx model "${plan.model.alias}", not mp3 (audio/mpeg).\n  sfx output is mp3 only: run the item with provider elevenlabs.`,
      UNSUPPORTED_MEDIA_TYPE
    );
  }
  ctx.log.info("fal:sfx:done", { requestId: job.requestId, bytes: bytes.length });

  const meta = {
    model: plan.model.alias,
    endpoint: job.endpoint,
    requestId: job.requestId,
    ...durationField(plan.request.durationMs)
  };
  return { audio: bytes, mimeType: MP3_MIME, costUsd: plan.costUsd, meta };
}

/**
 * Creates the fal sfx handler registered under `("sfx", "fal")`. `estimate`
 * touches no network and needs no key. `execute` submits one queue job and
 * waits in process, every `config.pollIntervalMs`, at most `config.jobTimeoutMs`.
 *
 * @param ctx - Plugin context (config, state, env, log).
 * @returns The handler: estimate and execute.
 */
export function createSfxHandler(ctx: FalContext): SfxHandler {
  const requestLog = createRequestLog(ctx);

  return {
    estimate: (request: SfxRequest): { usd: number } => ({
      usd: planSfx(ctx, request).costUsd
    }),
    execute: async (request: SfxRequest, opts: { signal?: AbortSignal }): Promise<SfxResult> => {
      const plan = planSfx(ctx, request);
      const { jobId } = await submitSfx(ctx, requestLog, plan, opts.signal);
      return runQueueJob(ctx, jobId, opts.signal, (job, apiKey) =>
        collectSfx(ctx, job, plan, apiKey, opts.signal)
      );
    }
  };
}
