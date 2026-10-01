/**
 * @file ark image handler — implements the execute-only image contract
 * (`../../image/contract.ts`) over Seedream text-to-image and image-to-image
 * (`POST {dataPlane}/images/generations`, Bearer API key). Local refs go out
 * as data URIs, so nothing is hosted. One call makes one
 * image; its URL is downloaded once, without the key, and the bytes are
 * returned UNCHANGED: never decoded, resized, cropped or re-encoded. BytePlus
 * trusts a face in a later Seedance request only in those original bytes.
 */
import type { ImageHandler, ImageRequest, ImageResult } from "../../image/contract";
import {
  arkFetch,
  bearerHeaders,
  readField,
  readJson,
  readNumber,
  readString,
  unreadableResponse
} from "../client";
import { imageCostUsd } from "../prices";
import { dataPlaneUrl } from "../regions";
import type { ArkContext } from "../types";
import {
  buildImageBody,
  checkImageRequest,
  imageMimeOf,
  readReferenceImages,
  warnImageNegativeOnce
} from "./body";
import { resolveArkImageModel } from "./models";

/** Data-plane path of the image generation API. */
const GENERATIONS_PATH = "/images/generations";

/**
 * The first generated image of a response body, still untrusted.
 *
 * @param body - The parsed response body.
 * @returns `data[0]`, or undefined.
 * @example
 * ```ts
 * firstImageOf({ data: [{ url: "https://example.invalid/key.jpeg" }] }); // => { url: "https://example.invalid/key.jpeg" }
 * ```
 */
function firstImageOf(body: unknown): unknown {
  const data = readField(body, "data");
  return Array.isArray(data) ? data[0] : undefined;
}

/**
 * Checks the request, generates one image, downloads it once and returns
 * the bytes unchanged. The API key is read through `ctx.env` (MC3). Once
 * the POST is sent the call runs to the end, so a paid image is not lost to a
 * pause.
 *
 * @param ctx - Plugin context.
 * @param request - The image request.
 * @param signal - Caller abort signal, checked before the POST.
 * @returns The image, its MIME type and its cost.
 */
async function executeImage(
  ctx: ArkContext,
  request: ImageRequest,
  signal: AbortSignal | undefined
): Promise<ImageResult> {
  // Refuse what Seedream here cannot take, before any call.
  const model = resolveArkImageModel(request.model, ctx.config.region);
  const checked = checkImageRequest(model, request);
  const apiKey = ctx.env.require(ctx.config.apiKeyEnv);
  warnImageNegativeOnce(ctx, model.id, request);
  const referenceImages = await readReferenceImages(request.refs ?? []);

  // Generate one image; ark answers with its URL.
  signal?.throwIfAborted();
  const response = await arkFetch(
    `${dataPlaneUrl(ctx.config)}${GENERATIONS_PATH}`,
    {
      method: "POST",
      headers: bearerHeaders(apiKey),
      body: JSON.stringify(buildImageBody(model, request.prompt, checked, referenceImages))
    },
    { timeoutMs: ctx.config.timeoutMs, label: GENERATIONS_PATH }
  );
  const body = readJson(response);
  const imageUrl = readString(firstImageOf(body), "url");
  if (imageUrl === undefined) throw unreadableResponse(GENERATIONS_PATH);

  // Download the original bytes once, without the key, and never touch them.
  const download = await arkFetch(
    imageUrl,
    { method: "GET" },
    { timeoutMs: ctx.config.downloadTimeoutMs, label: "image download" }
  );
  const images = readNumber(readField(body, "usage"), "generated_images") ?? 1;

  ctx.log.info("ark:image:done", { model: model.id, bytes: download.body.length });
  return {
    image: download.body,
    mimeType: imageMimeOf(download.headers.get("content-type"), download.body),
    costUsd: imageCostUsd(ctx.config, model, images),
    meta: { model: model.id, size: checked.size }
  };
}

/**
 * Creates the ark image handler registered under `("image", "ark")`.
 * `estimate` touches no network and needs no key: it checks the request with
 * the execute errors and prices one image. `execute` makes one Seedream
 * call: text-to-image, or image-to-image when the request has refs.
 *
 * @param ctx - Plugin context (config, state, env, log).
 * @returns The handler: estimate and execute.
 */
export function createImageHandler(ctx: ArkContext): ImageHandler {
  return {
    estimate: (request: ImageRequest): { usd: number } => {
      const model = resolveArkImageModel(request.model, ctx.config.region);
      checkImageRequest(model, request);
      return { usd: imageCostUsd(ctx.config, model, 1) };
    },
    execute: (request: ImageRequest, opts: { signal?: AbortSignal }): Promise<ImageResult> =>
      executeImage(ctx, request, opts.signal)
  };
}
