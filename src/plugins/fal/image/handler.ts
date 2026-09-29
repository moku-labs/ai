/**
 * @file fal image handler — estimate, execute, and the submit/poll job form
 * over the generic queue. Everything is validated and priced before the key
 * is read or anything is uploaded; the queue POST carries no caller signal.
 */
import type { ImageHandler, ImageRequest, ImageResult } from "../../image/contract";
import { readField, readNumber, readString, resolveApiKey } from "../client/http";
import type { FalJob } from "../client/queue";
import {
  downloadFile,
  encodeJobId,
  fetchJobResult,
  mimeFromUrl,
  passthroughParameters,
  pollQueueJob,
  runQueueJob,
  submitJob
} from "../client/queue";
import { uploadFiles } from "../client/upload";
import type { RequestLog, RequestLogEntry } from "../log";
import { createRequestLog, withRequestLog } from "../log";
import { resolvePrices } from "../prices";
import type { FalContext, LocalFile } from "../types";
import { TerminalProviderError } from "../types";
import type { ResolvedImageModel } from "./models";
import {
  checkImageAspect,
  DEFAULT_IMAGE_ASPECT,
  imageResolution,
  promptWithNegative,
  resolveImageModel
} from "./models";
import { imagePriceOf } from "./prices";

/**
 * One poll of an image job. The image contract has no job form, so it is declared here.
 *
 * @example
 * ```ts
 * const poll: ImageJobPoll = { state: "pending" };
 * ```
 */
export type ImageJobPoll =
  | { state: "pending" }
  | ({ state: "done" } & ImageResult)
  | { state: "failed"; error: unknown };

/**
 * The image contract plus the job pair the runner drives (`isJobHandler`).
 *
 * @example
 * ```ts
 * const { jobId } = await handler.submit({ prompt: "hero shot", model: "nano-banana-pro" }, {});
 * ```
 */
export type FalImageHandler = ImageHandler & {
  /** Uploads the refs and queues the job; returns the opaque job id. */
  submit(request: ImageRequest, opts: { signal?: AbortSignal }): Promise<{ jobId: string }>;
  /** Reads the job once; a completed job is downloaded. */
  poll(jobId: string, request: ImageRequest, opts: { signal?: AbortSignal }): Promise<ImageJobPoll>;
};

/**
 * Everything checked before any I/O: the model, the endpoint choice, the
 * aspect, the resolution and the cost.
 *
 * @example
 * ```ts
 * planImage(ctx, { prompt: "p", model: "nano-banana-pro" }).costUsd; // => 0.15
 * ```
 */
export type ImagePlan = {
  /** The resolved catalog row. */
  model: ResolvedImageModel;
  /** Checked aspect ratio. */
  aspect: string;
  /** Planned resolution, if any. */
  resolution: string | undefined;
  /** How many refs the request has (resolved or not). */
  refCount: number;
  /** USD for one image. */
  costUsd: number;
};

/** Params the body builders map themselves; never passed through. */
const CONSUMED_PARAMS: readonly string[] = ["resolution", "quality"];

/** Log event for a failed image job. */
const FAILED_EVENT = "fal:image:failed";

/** MIME type when neither fal, the download nor the URL names one. */
const DEFAULT_MIME = "image/png";

/** MIME types by output file extension. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp"
};

/** Status of a request refused before any upload or charge. */
const BAD_REQUEST = 400;

/**
 * Plans a request without I/O: model (default `config.imageDefaultModel`),
 * ref count against the model's limit (refs may still be `$ref`s), resolution,
 * aspect and cost.
 *
 * @param ctx - Plugin context (config, price table).
 * @param request - The image request.
 * @returns The plan.
 * @throws {TerminalProviderError} A 400 for an unknown model, too many refs, a bad resolution or aspect, or a missing price.
 */
export function planImage(ctx: FalContext, request: ImageRequest): ImagePlan {
  const model = resolveImageModel(request.model ?? ctx.config.imageDefaultModel);

  // Only the count is read here: refs may still be unresolved `$ref` objects.
  const refCount = request.refs?.length ?? 0;
  if (refCount > model.maxRefs) {
    throw new TerminalProviderError(
      `[ai] fal image model "${model.alias}" takes at most ${model.maxRefs} reference images, got ${refCount}.\n  Remove refs from input.refs, or use a model that takes more.`,
      BAD_REQUEST
    );
  }

  // Resolution first: it picks the size table the aspect is checked against.
  const resolution = imageResolution(model, request.params?.resolution);
  const aspect = request.aspect ?? DEFAULT_IMAGE_ASPECT;
  checkImageAspect(model, aspect, resolution);

  const costUsd = imagePriceOf(resolvePrices(ctx), model.alias, resolution);
  return { model, aspect, resolution, refCount, costUsd };
}

/**
 * Whether a ref is a resolved local file rather than a `$ref` / `$file`.
 *
 * @param value - A request ref.
 * @returns True for `{ path, mimeType, hash }`.
 * @example
 * ```ts
 * isLocalFile({ $ref: "s01.face" }); // => false
 * ```
 */
function isLocalFile(value: unknown): value is LocalFile {
  return (
    readString(value, "path") !== undefined &&
    readString(value, "mimeType") !== undefined &&
    readString(value, "hash") !== undefined
  );
}

/**
 * The refs as local files; every one must be resolved.
 *
 * @param references - The request's refs.
 * @returns The files, in request order.
 * @throws {TerminalProviderError} A 400 when a ref is not resolved.
 * @example
 * ```ts
 * resolvedFiles([{ path: "a.png", mimeType: "image/png", hash: "h" }]).length; // => 1
 * ```
 */
function resolvedFiles(references: readonly unknown[]): LocalFile[] {
  const files = references.filter(reference => isLocalFile(reference));
  if (files.length !== references.length) {
    throw new TerminalProviderError(
      "[ai] fal image got an unresolved reference.\n  Run the item through app.runner, or pass { path, mimeType, hash } files.",
      BAD_REQUEST
    );
  }
  return files;
}

/**
 * The posted body: pass-through params first, mapped fields last, so params
 * can never raise `num_images` or switch the size.
 *
 * @param plan - The plan.
 * @param request - The image request.
 * @param imageUrls - Uploaded ref URLs.
 * @returns The body.
 * @example
 * ```ts
 * const plan: ImagePlan = { model: resolveImageModel("nano-banana-pro"), aspect: "9:16", resolution: "1K", refCount: 0, costUsd: 0.15 };
 * imageBody(plan, { prompt: "hero", params: { num_images: 4, seed: 7 } }, []).num_images; // => 1
 * imageBody(plan, { prompt: "hero", params: { num_images: 4, seed: 7 } }, []).seed; // => 7
 * ```
 */
function imageBody(
  plan: ImagePlan,
  request: ImageRequest,
  imageUrls: readonly string[]
): Record<string, unknown> {
  const quality = request.params?.quality;
  return {
    ...passthroughParameters(request.params, CONSUMED_PARAMS),
    ...plan.model.body({
      prompt: promptWithNegative(request.prompt, request.negative),
      aspect: plan.aspect,
      resolution: plan.resolution,
      imageUrls,
      quality: typeof quality === "string" ? quality : undefined
    })
  };
}

/**
 * Plans, uploads the refs and queues the job, writing the request log line
 * around the queue POST.
 *
 * @param ctx - Plugin context.
 * @param requestLog - The request log, or undefined when off.
 * @param request - The image request.
 * @param signal - Caller abort signal (uploads only).
 * @returns The opaque job id.
 */
async function submitImage(
  ctx: FalContext,
  requestLog: RequestLog | undefined,
  request: ImageRequest,
  signal: AbortSignal | undefined
): Promise<{ jobId: string }> {
  // Refuse what the model cannot take and read the key, before any upload.
  const plan = planImage(ctx, request);
  const files = resolvedFiles(request.refs ?? []);
  const apiKey = resolveApiKey(ctx);

  // Upload the refs; an abort here stops before anything is billed.
  const imageUrls = await uploadFiles(ctx, files, { apiKey, signal });
  signal?.throwIfAborted();

  // Choose the endpoint (edit when there are refs), then build the body and its log entry.
  const { model } = plan;
  const endpoint = plan.refCount > 0 ? model.editEndpoint : model.textEndpoint;
  const body = imageBody(plan, request, imageUrls);
  const entry: RequestLogEntry = {
    task: "image",
    model: model.alias,
    endpoint,
    prompt: readString(body, "prompt") ?? request.prompt,
    body,
    files
  };

  // Queue the job: once the POST is sent fal may bill it, so it runs to the end without the signal.
  const job = await withRequestLog(
    requestLog,
    entry,
    () => submitJob(ctx, endpoint, body, { apiKey, timeoutMs: ctx.config.timeoutMs }),
    submitted => submitted.requestId
  );
  ctx.log.info("fal:image:submitted", { model: model.alias, endpoint, requestId: job.requestId });
  return { jobId: encodeJobId(job) };
}

/**
 * Collects a completed job: result body, `images[0]`, CDN download (no key).
 * The MIME type is fal's `content_type`, else the download header, else the
 * URL extension, else `image/png`.
 *
 * @param ctx - Plugin context.
 * @param job - The job.
 * @param request - The request the job was submitted with.
 * @param apiKey - The fal key (result call only).
 * @param signal - Caller abort signal.
 * @returns The image result.
 * @throws {Error} A plain error when the result has no `images[0].url`; any call error.
 */
async function collectImage(
  ctx: FalContext,
  job: FalJob,
  request: ImageRequest,
  apiKey: string,
  signal: AbortSignal | undefined
): Promise<ImageResult> {
  // The result body names the image; without images[0].url there is nothing to download.
  const { timeoutMs } = ctx.config;
  const body = await fetchJobResult(job, { apiKey, timeoutMs, signal });
  const images = readField(body, "images");
  const first: unknown = Array.isArray(images) ? images[0] : undefined;
  const url = readString(first, "url");
  if (url === undefined) {
    throw new Error(
      "[ai] fal returned an incomplete image result.\n  Expected images[0].url in the response."
    );
  }

  // The CDN download goes without the key.
  const { bytes, contentType } = await downloadFile(url, { timeoutMs, signal });
  const mimeType =
    readString(first, "content_type") ??
    contentType ??
    mimeFromUrl(url, MIME_BY_EXTENSION) ??
    DEFAULT_MIME;
  ctx.log.info("fal:image:done", { requestId: job.requestId, bytes: bytes.length });

  // Model and cost come from the plan of the request the job was submitted with.
  const plan = planImage(ctx, request);

  // Width and height only when fal reports them as numbers.
  const width = readNumber(first, "width");
  const height = readNumber(first, "height");
  const meta = {
    model: plan.model.alias,
    endpoint: job.endpoint,
    requestId: job.requestId,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height })
  };
  return { image: bytes, mimeType, costUsd: plan.costUsd, meta };
}

/**
 * Creates the fal image handler registered under `("image", "fal")`.
 * `estimate` touches no network and needs no key. `submit` + `poll` is the
 * job form the runner journals; `execute` (the `app.image` facade) submits and
 * waits in process, every `config.pollIntervalMs`, at most `config.jobTimeoutMs`.
 *
 * @param ctx - Plugin context (config, state, env, log).
 * @returns The handler: estimate, execute, submit and poll.
 */
export function createImageHandler(ctx: FalContext): FalImageHandler {
  const requestLog = createRequestLog(ctx);
  const collect =
    (request: ImageRequest, signal: AbortSignal | undefined) =>
    (job: FalJob, apiKey: string): Promise<ImageResult> =>
      collectImage(ctx, job, request, apiKey, signal);

  return {
    estimate: (request: ImageRequest): { usd: number } => ({
      usd: planImage(ctx, request).costUsd
    }),
    submit: (request: ImageRequest, opts: { signal?: AbortSignal }): Promise<{ jobId: string }> =>
      submitImage(ctx, requestLog, request, opts.signal),
    poll: (
      jobId: string,
      request: ImageRequest,
      opts: { signal?: AbortSignal }
    ): Promise<ImageJobPoll> =>
      pollQueueJob(ctx, jobId, opts.signal, FAILED_EVENT, collect(request, opts.signal)),
    execute: async (
      request: ImageRequest,
      opts: { signal?: AbortSignal }
    ): Promise<ImageResult> => {
      const { jobId } = await submitImage(ctx, requestLog, request, opts.signal);
      return runQueueJob(ctx, jobId, opts.signal, collect(request, opts.signal));
    }
  };
}
