/**
 * @file ark image handler — implements the execute-only image contract
 * (`../../image/contract.ts`) over Seedream text-to-image and image-to-image
 * (`POST {dataPlane}/images/generations`, Bearer API key). Local refs go out
 * as data URIs, so nothing is hosted. One call makes one
 * image, or with `params.images` a group of up to that many; each URL is
 * downloaded once, without the key, and the bytes are
 * returned UNCHANGED: never decoded, resized, cropped or re-encoded. BytePlus
 * trusts a face in a later Seedance request only in those original bytes.
 */
import type { ImageHandler, ImageOutput, ImageRequest, ImageResult } from "../../image/contract";
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
  type CheckedImageRequest,
  checkImageRequest,
  imageMimeOf,
  readReferenceImages,
  warnImageNegativeOnce
} from "./body";
import { type ArkImageModel, resolveArkImageModel } from "./models";

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
 * Every image URL of a group response, in `data[]` order. An entry without a
 * string `url` (such as an `error` entry) is skipped: it is not a failure of the call.
 *
 * @param body - The parsed response body.
 * @returns The URLs; empty when no entry has one.
 * @example
 * ```ts
 * imageUrlsOf({ data: [{ url: "https://example.invalid/1.jpeg" }, { error: {} }] }); // => ["https://example.invalid/1.jpeg"]
 * ```
 */
function imageUrlsOf(body: unknown): string[] {
  const data = readField(body, "data");
  if (!Array.isArray(data)) return [];

  return data.map(entry => readString(entry, "url")).filter(url => url !== undefined);
}

/**
 * Images billed for a response: `usage.generated_images`, else `fallback`.
 *
 * @param body - The parsed response body.
 * @param fallback - The count when the response has no usage.
 * @returns The image count to price.
 * @example
 * ```ts
 * billedImagesOf({ usage: { generated_images: 4 } }, 6); // => 4
 * ```
 */
function billedImagesOf(body: unknown, fallback: number): number {
  return readNumber(readField(body, "usage"), "generated_images") ?? fallback;
}

/**
 * Downloads one generated image once, without the key, and never touches
 * the bytes.
 *
 * @param ctx - Plugin context (config).
 * @param url - The image URL from the response.
 * @returns The original bytes and their MIME type.
 */
async function downloadImage(ctx: ArkContext, url: string): Promise<ImageOutput> {
  const download = await arkFetch(
    url,
    { method: "GET" },
    { timeoutMs: ctx.config.downloadTimeoutMs, label: "image download" }
  );
  return {
    image: download.body,
    mimeType: imageMimeOf(download.headers.get("content-type"), download.body)
  };
}

/**
 * The one-image result: `data[0]` downloaded, priced per
 * `usage.generated_images` (1 without usage).
 *
 * @param ctx - Plugin context (config, log).
 * @param model - The image catalog row.
 * @param checked - The checked request.
 * @param body - The parsed response body.
 * @returns The image, its MIME type, its cost and `{ model, size }`.
 * @throws {RetryableProviderError} 502 when `data[0]` has no URL.
 */
async function singleImageResult(
  ctx: ArkContext,
  model: ArkImageModel,
  checked: CheckedImageRequest,
  body: unknown
): Promise<ImageResult> {
  const imageUrl = readString(firstImageOf(body), "url");
  if (imageUrl === undefined) throw unreadableResponse(GENERATIONS_PATH);

  const { image, mimeType } = await downloadImage(ctx, imageUrl);

  ctx.log.info("ark:image:done", { model: model.id, bytes: image.length });
  return {
    image,
    mimeType,
    costUsd: imageCostUsd(ctx.config, model, billedImagesOf(body, 1)),
    meta: { model: model.id, size: checked.size }
  };
}

/**
 * The group result: every `data[]` URL downloaded once, in order, `image`
 * being the first. Ark makes at most `requested` images; fewer is not an
 * error, only an `ark:image:group-short` warning. Priced per
 * `usage.generated_images`, else per image returned: BytePlus bills the images it made.
 *
 * @param ctx - Plugin context (config, log).
 * @param model - The image catalog row.
 * @param checked - The checked request.
 * @param body - The parsed response body.
 * @param requested - `params.images`.
 * @returns The first image, every image, the cost and `{ model, size, imagesRequested, imagesReturned }`.
 * @throws {RetryableProviderError} 502 when no `data[]` entry has a URL.
 */
async function groupImageResult(
  ctx: ArkContext,
  model: ArkImageModel,
  checked: CheckedImageRequest,
  body: unknown,
  requested: number
): Promise<ImageResult> {
  // Download every image once, in order; a response with none is unreadable.
  const images = await Promise.all(imageUrlsOf(body).map(url => downloadImage(ctx, url)));
  const [first] = images;
  if (first === undefined) throw unreadableResponse(GENERATIONS_PATH);

  // A short group is a result, not an error: warn and bill what was made.
  const returned = images.length;
  if (returned < requested) {
    ctx.log.warn("ark:image:group-short", { model: model.id, requested, returned });
  }
  const bytes = images.reduce((total, output) => total + output.image.length, 0);

  ctx.log.info("ark:image:done", { model: model.id, bytes, images: returned });
  return {
    image: first.image,
    mimeType: first.mimeType,
    images,
    costUsd: imageCostUsd(ctx.config, model, billedImagesOf(body, returned)),
    meta: {
      model: model.id,
      size: checked.size,
      imagesRequested: requested,
      imagesReturned: returned
    }
  };
}

/**
 * Checks the request, generates one image or a group, downloads each once
 * and returns the bytes unchanged. The API key is read through `ctx.env` (MC3). Once
 * the POST is sent the call runs to the end, so a paid image is not lost to a
 * pause.
 *
 * @param ctx - Plugin context.
 * @param request - The image request.
 * @param signal - Caller abort signal, checked before the POST.
 * @returns The image, its MIME type and its cost; a group also lists every image.
 */
async function executeImage(
  ctx: ArkContext,
  request: ImageRequest,
  signal: AbortSignal | undefined
): Promise<ImageResult> {
  // Refuse what Seedream here cannot take and read the refs, before any call.
  const model = resolveArkImageModel(request.model, ctx.config.region);
  const checked = checkImageRequest(model, request);
  const apiKey = ctx.env.require(ctx.config.apiKeyEnv);
  warnImageNegativeOnce(ctx, model.id, request);
  const referenceImages = await readReferenceImages(request.refs ?? []);

  // Generate; ark answers with the image URLs.
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

  // Download the original bytes: one image, or every image of the group.
  if (checked.images === undefined) return singleImageResult(ctx, model, checked, body);
  return groupImageResult(ctx, model, checked, body, checked.images);
}

/**
 * Creates the ark image handler registered under `("image", "ark")`.
 * `estimate` touches no network and needs no key: it checks the request with
 * the execute errors and prices one image, or `params.images` images for a
 * group (an upper bound: ark may make fewer). `execute` makes one Seedream
 * call: text-to-image, or image-to-image when the request has refs, one
 * image or a group.
 *
 * @param ctx - Plugin context (config, state, env, log).
 * @returns The handler: estimate and execute.
 */
export function createImageHandler(ctx: ArkContext): ImageHandler {
  return {
    estimate: (request: ImageRequest): { usd: number } => {
      const model = resolveArkImageModel(request.model, ctx.config.region);
      const checked = checkImageRequest(model, request);
      return { usd: imageCostUsd(ctx.config, model, checked.images ?? 1) };
    },
    execute: (request: ImageRequest, opts: { signal?: AbortSignal }): Promise<ImageResult> =>
      executeImage(ctx, request, opts.signal)
  };
}
