/**
 * @file apimodels video handler — implements the task-owned contract
 * (`../../video/contract.ts`) over the apimodels task API. `estimate` is
 * network-free. `submit` uploads the plain inputs, resolves the inputs named
 * in `params.assets` to `asset://` ids, and POSTs the task. `poll`
 * (`./poll.ts`) reads the task once and, when it is completed, downloads the
 * clip and reads the real charge. There is no `execute`: the runner and the
 * `video` facade both drive `submit` + `poll`. The job id is JSON (task id,
 * alias, asset cost), so a restart adopts the task instead of paying again.
 */
import type {
  EstimateRequest,
  VideoFile,
  VideoHandler,
  VideoJobPoll,
  VideoRequest
} from "../../video/contract";
import {
  isStaleAssetRejection,
  listInputs,
  readAssetSelectors,
  resolveAssets,
  selectAssetFiles
} from "../assets";
import { apiData, isEmpty } from "../client";
import { TerminalProviderError } from "../errors";
import { BAD_REQUEST, UNAUTHORIZED } from "../http";
import { assetPriceUsd, roundUsd, videoCostUsd } from "../prices";
import type { ApimodelsContext } from "../types";
import type { UploadOptions } from "../upload";
import { uploadFiles } from "../upload";
import { encodeJobId, readTask } from "./job";
import type { InputUrls, ReferenceKind, ResolvedModel } from "./models";
import { buildBody, checkRequest, referenceKindOf, resolveModel } from "./models";
import { FAILED, pollJob, readApiKey, staleAssetError, taskFailure } from "./poll";

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
      UNAUTHORIZED
    );
  }
  return apiKey;
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
  if (isEmpty(task.taskId)) {
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
