/**
 * @file fal sprite handler — background removal on fal, then the pixel step.
 * A matte model (`birefnet`) uploads the source, runs one queue job and
 * downloads the cut-out; `none` skips fal (no key, no HTTP, cost 0). Either
 * way `processSprite` from the sprite plugin trims, pads, resizes and encodes
 * the PNG (decision D6: a runtime import of a function module, no `depends`
 * edge). The request is validated and priced before the key is read or
 * anything is uploaded; the queue POST carries no caller signal.
 */
import { readFile } from "node:fs/promises";
import type { SpriteHandler, SpriteRequest, SpriteResult } from "../../sprite/contract";
import type { ProcessedSprite } from "../../sprite/process";
import { processSprite } from "../../sprite/process";
import { readField, readString, resolveApiKey } from "../client/http";
import type { FalJob } from "../client/queue";
import { downloadFile, encodeJobId, fetchJobResult, runQueueJob, submitJob } from "../client/queue";
import { createUploadSession, uploadOne } from "../client/upload";
import type { RequestLog, RequestLogEntry } from "../log";
import { createRequestLog, withRequestLog } from "../log";
import { resolvePrices } from "../prices";
import type { FalContext, LocalFile } from "../types";
import type { MatteAlias, MatteModel, MatteParameters } from "./models";
import { checkSpriteRequest, resolveSpriteModel } from "./models";
import { spritePriceOf } from "./prices";

/**
 * Everything checked before any I/O for a matte model: the row, the source,
 * the matte params, the request and the cost.
 *
 * @example
 * ```ts
 * const plan: MattePlan = { model: { ...matteModels.birefnet, alias: "birefnet" }, source: file, params: {}, request, costUsd: 0.002 };
 * ```
 */
export type MattePlan = {
  /** The matte catalog row with its alias. */
  model: MatteModel & { alias: MatteAlias };
  /** The resolved source file. */
  source: LocalFile;
  /** The checked matte params. */
  params: MatteParameters;
  /** The request, for the pixel step. */
  request: SpriteRequest;
  /** USD for this image. */
  costUsd: number;
};

/** The MIME type of every sprite. */
const PNG_MIME = "image/png";

/**
 * The result of a cut, from `processSprite`'s output.
 *
 * @param cut - The processed sprite.
 * @param costUsd - USD for this sprite.
 * @param meta - Model and request metadata, before the geometry.
 * @returns The sprite result.
 * @example
 * ```ts
 * spriteResult(cut, 0, { model: "none" }).mimeType; // => "image/png"
 * ```
 */
function spriteResult(
  cut: ProcessedSprite,
  costUsd: number,
  meta: Record<string, unknown>
): SpriteResult {
  const { image, width, height, trimBox } = cut;
  return { image, mimeType: PNG_MIME, costUsd, meta: { ...meta, width, height, trimBox } };
}

/**
 * Reads the source bytes of a `none` sprite.
 *
 * @param source - The resolved source file.
 * @returns The bytes.
 * @throws {Error} A plain (terminal) error when the file cannot be read.
 */
async function readSource(source: LocalFile): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(source.path));
  } catch {
    throw new Error(
      `[ai] Cannot read sprite source "${source.path}".\n  Check that the $ref or $file it came from still exists.`
    );
  }
}

/**
 * Cuts a source that is already transparent: no key, no HTTP, cost 0.
 *
 * @param source - The resolved source file.
 * @param request - The sprite request (pixel options).
 * @param signal - Caller abort signal; checked once before any work.
 * @returns The sprite result.
 */
async function cutSource(
  source: LocalFile,
  request: SpriteRequest,
  signal: AbortSignal | undefined
): Promise<SpriteResult> {
  signal?.throwIfAborted();
  const cut = await processSprite(await readSource(source), request);
  return spriteResult(cut, 0, { model: "none" });
}

/**
 * Reads the key, uploads the source and queues the matte job, writing the
 * request log line around the queue POST.
 *
 * @param ctx - Plugin context.
 * @param requestLog - The request log, or undefined when off.
 * @param plan - The matte plan.
 * @param signal - Caller abort signal (upload only).
 * @returns The opaque job id.
 */
async function submitMatte(
  ctx: FalContext,
  requestLog: RequestLog | undefined,
  plan: MattePlan,
  signal: AbortSignal | undefined
): Promise<{ jobId: string }> {
  // Upload the source; an abort here stops before anything is billed.
  const apiKey = resolveApiKey(ctx);
  const session = createUploadSession(ctx);
  const imageUrl = await uploadOne(ctx, session, plan.source, { apiKey, signal });
  signal?.throwIfAborted();

  // Queue the job: once the POST is sent fal may bill it, so it runs to the end without the signal.
  const { model } = plan;
  const body = model.body(imageUrl, plan.params);
  const entry: RequestLogEntry = {
    task: "sprite",
    model: model.alias,
    endpoint: model.endpoint,
    prompt: "",
    body,
    files: [plan.source]
  };
  const job = await withRequestLog(
    requestLog,
    entry,
    () => submitJob(ctx, model.endpoint, body, { apiKey, timeoutMs: ctx.config.timeoutMs }),
    submitted => submitted.requestId
  );

  ctx.log.info("fal:sprite:submitted", {
    model: model.alias,
    endpoint: model.endpoint,
    requestId: job.requestId
  });
  return { jobId: encodeJobId(job) };
}

/**
 * Collects a completed matte job: result body, `image.url`, CDN download
 * (no key), then the pixel step on the downloaded cut-out.
 *
 * @param ctx - Plugin context.
 * @param job - The job.
 * @param plan - The matte plan of the request the job was submitted with.
 * @param apiKey - The fal key (result call only).
 * @param signal - Caller abort signal.
 * @returns The sprite result.
 * @throws {Error} A plain error when the result has no `image.url`; any call or pixel-step error.
 */
async function collectMatte(
  ctx: FalContext,
  job: FalJob,
  plan: MattePlan,
  apiKey: string,
  signal: AbortSignal | undefined
): Promise<SpriteResult> {
  // The result body names the cut-out; without image.url there is nothing to download.
  const { timeoutMs } = ctx.config;
  const body = await fetchJobResult(job, { apiKey, timeoutMs, signal });
  const url = readString(readField(body, "image"), "url");
  if (url === undefined) {
    throw new Error(
      "[ai] fal returned an incomplete sprite result.\n  Expected image.url in the response."
    );
  }

  // The CDN download goes without the key; the pixel step reads any format sharp reads.
  const { bytes } = await downloadFile(url, { timeoutMs, signal });
  ctx.log.info("fal:sprite:done", { requestId: job.requestId, bytes: bytes.length });

  const cut = await processSprite(bytes, plan.request);
  const meta = { model: plan.model.alias, endpoint: job.endpoint, requestId: job.requestId };
  return spriteResult(cut, plan.costUsd, meta);
}

/**
 * Creates the fal sprite handler registered under `("sprite", "fal")`.
 * `estimate` reads the model only (the runner estimates before the source
 * is resolved) and touches no network. `execute` validates the whole request
 * first; a matte model then submits one queue job and waits in process,
 * every `config.pollIntervalMs`, at most `config.jobTimeoutMs`.
 *
 * @param ctx - Plugin context (config, state, env, log).
 * @returns The handler: estimate and execute.
 */
export function createSpriteHandler(ctx: FalContext): SpriteHandler {
  const requestLog = createRequestLog(ctx);

  return {
    estimate: (request: SpriteRequest): { usd: number } => ({
      usd: spritePriceOf(resolvePrices(ctx), resolveSpriteModel(request.model).alias)
    }),
    execute: async (
      request: SpriteRequest,
      opts: { signal?: AbortSignal }
    ): Promise<SpriteResult> => {
      const { model, source, params } = checkSpriteRequest(request);
      const costUsd = spritePriceOf(resolvePrices(ctx), model.alias);
      if (model.alias === "none") return cutSource(source, request, opts.signal);

      const plan: MattePlan = { model, source, params, request, costUsd };
      const { jobId } = await submitMatte(ctx, requestLog, plan, opts.signal);
      return runQueueJob(ctx, jobId, opts.signal, (job, apiKey) =>
        collectMatte(ctx, job, plan, apiKey, opts.signal)
      );
    }
  };
}
