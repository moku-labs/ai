/**
 * @file ark image body — maps an `ImageRequest` plus `params` to the Seedream
 * body (`POST {base}/images/generations`). `checkImageRequest` refuses what
 * Seedream here cannot take (no I/O): refs, unknown params, an unknown
 * aspect, a size below the model's minimum. `buildImageBody` assembles the
 * body (pure). `imageMimeOf` names the downloaded bytes without touching
 * them: ark trusts a face only in the original bytes.
 */
import type { ImageRequest } from "../../image/contract";
import type { ArkContext } from "../types";
import type { ArkImageModel } from "./models";

/**
 * The `size` sent for each `aspect`: all at least 3,686,400 pixels.
 *
 * @example
 * ```ts
 * ARK_IMAGE_SIZES["9:16"]; // => "1440x2560"
 * ```
 */
export const ARK_IMAGE_SIZES: Readonly<Record<string, string>> = {
  "9:16": "1440x2560",
  "16:9": "2560x1440",
  "1:1": "2048x2048",
  "3:4": "1728x2304",
  "4:3": "2304x1728"
};

/**
 * The `params` keys an ark image takes. `generation` is never sent: it only
 * changes the item key.
 *
 * @example
 * ```ts
 * ARK_IMAGE_PARAMS.join(", "); // => "size, seed, generation, watermark"
 * ```
 */
export const ARK_IMAGE_PARAMS = ["size", "seed", "generation", "watermark"] as const;

/**
 * The Seedream body POSTed to ark.
 *
 * @example
 * ```ts
 * const body: ArkImageBody = {
 *   model: "seedream-5-0-lite-260128", prompt: "p", size: "1440x2560", response_format: "url", watermark: false
 * };
 * ```
 */
export type ArkImageBody = {
  /** Ark model id. */
  model: string;
  /** The prompt, sent as given. */
  prompt: string;
  /** `<width>x<height>`, at least the model's minimum pixels. */
  size: string;
  /** Always a URL: the bytes are downloaded once, unchanged. */
  response_format: "url";
  /** `params.watermark` as given; false by default. */
  watermark: unknown;
  /** `params.seed` as given, when set. */
  seed?: unknown;
};

/**
 * An image request checked against the model, with defaults applied.
 *
 * @example
 * ```ts
 * const checked: CheckedImageRequest = { size: "1440x2560", watermark: false, seed: undefined };
 * ```
 */
export type CheckedImageRequest = {
  /** The size sent. */
  size: string;
  /** `params.watermark`, or false. Ark validates the value. */
  watermark: unknown;
  /** `params.seed`, when set. Ark validates the value. */
  seed: unknown;
};

/** `aspect` when the request names none. */
const DEFAULT_ASPECT = "9:16";

/** A size written as `<width>x<height>`. */
const SIZE_PATTERN = /^(\d+)x(\d+)$/;

/** MIME type of bytes nothing recognizes. */
const OCTET_STREAM = "application/octet-stream";

/** The error for a request with refs. */
const REFS_ERROR = "[ai] ark images are text-to-image only.\n  Remove input.refs.";

/** The error for a `params.size` that is not `<width>x<height>`. */
const SIZE_SHAPE_ERROR =
  '[ai] ark params.size must be "<width>x<height>".\n  Pass it like "1440x2560".';

/**
 * Whether a `params` key is one an ark image takes.
 *
 * @param key - A `params` key.
 * @returns True for a key in {@link ARK_IMAGE_PARAMS}.
 * @example
 * ```ts
 * isImageParameter("style"); // => false
 * ```
 */
function isImageParameter(key: string): boolean {
  return (ARK_IMAGE_PARAMS as readonly string[]).includes(key);
}

/**
 * Refuses a `params` key an ark image does not take.
 *
 * @param params - `request.params`.
 * @throws {Error} A plain two-line error naming the key and the allowed ones.
 * @example
 * ```ts
 * checkImageParameters({ style: "anime" });
 * // throws: '[ai] Unknown ark image param "style".\n  Allowed: size, seed, generation, watermark.'
 * ```
 */
function checkImageParameters(params: Record<string, unknown>): void {
  for (const key of Object.keys(params)) {
    if (isImageParameter(key)) continue;
    throw new Error(
      `[ai] Unknown ark image param "${key}".\n  Allowed: ${ARK_IMAGE_PARAMS.join(", ")}.`
    );
  }
}

/**
 * The size of the table for an aspect.
 *
 * @param aspect - `request.aspect`; 9:16 when undefined.
 * @returns The size.
 * @throws {Error} A plain two-line error listing the aspects.
 * @example
 * ```ts
 * sizeOfAspect("16:9"); // => "2560x1440"
 * ```
 */
function sizeOfAspect(aspect: string | undefined): string {
  const wanted = aspect ?? DEFAULT_ASPECT;
  const size = ARK_IMAGE_SIZES[wanted];
  if (size !== undefined) return size;
  throw new Error(
    `[ai] ark image aspect "${wanted}" is not supported.\n  Use one of: ${Object.keys(ARK_IMAGE_SIZES).join(", ")}.`
  );
}

/**
 * Checks `params.size`: `<width>x<height>`, at least the model's minimum pixels.
 *
 * @param model - The image catalog row.
 * @param value - `params.size`, as given.
 * @param aspect - `request.aspect`, for the hint.
 * @returns The size.
 * @throws {Error} A plain two-line error for another shape or a size below the minimum.
 * @example
 * ```ts
 * checkSize(resolveArkImageModel(undefined, "intl"), "1152x2048", "9:16");
 * // throws: "[ai] ark image size 1152x2048 is below 3686400 pixels.\n  Use at least 1440x2560 for 9:16."
 * ```
 */
function checkSize(model: ArkImageModel, value: unknown, aspect: string | undefined): string {
  if (typeof value !== "string") throw new Error(SIZE_SHAPE_ERROR);
  const match = SIZE_PATTERN.exec(value);
  if (match === null) throw new Error(SIZE_SHAPE_ERROR);

  const pixels = Number(match[1]) * Number(match[2]);
  if (pixels >= model.minPixels) return match[0];
  const hintAspect =
    aspect !== undefined && ARK_IMAGE_SIZES[aspect] !== undefined ? aspect : DEFAULT_ASPECT;
  throw new Error(
    `[ai] ark image size ${match[0]} is below ${model.minPixels} pixels.\n  Use at least ${ARK_IMAGE_SIZES[hintAspect]} for ${hintAspect}.`
  );
}

/**
 * Checks an image request against the model, with no I/O: no refs, known
 * params only, and a size (`params.size`, else the aspect's) of at least the
 * model's minimum pixels. Every failure is a plain two-line error.
 *
 * @param model - The image catalog row.
 * @param request - The image request (refs may still be references at estimate time).
 * @returns The checked request, defaults applied.
 * @throws {Error} The first broken rule.
 * @example
 * ```ts
 * checkImageRequest(resolveArkImageModel(undefined, "intl"), { prompt: "p", aspect: "1:1" });
 * // => { size: "2048x2048", watermark: false, seed: undefined }
 * ```
 */
export function checkImageRequest(
  model: ArkImageModel,
  request: Pick<ImageRequest, "refs" | "params" | "aspect">
): CheckedImageRequest {
  if ((request.refs?.length ?? 0) > 0) throw new Error(REFS_ERROR);

  const params = request.params ?? {};
  checkImageParameters(params);
  const size =
    params.size === undefined
      ? sizeOfAspect(request.aspect)
      : checkSize(model, params.size, request.aspect);
  return { size, watermark: params.watermark ?? false, seed: params.seed };
}

/**
 * Assembles the Seedream body: one image by URL, `watermark` false by default,
 * the seed only when given.
 *
 * @param model - The image catalog row.
 * @param prompt - The prompt, sent as given.
 * @param checked - The checked request.
 * @returns The body.
 * @example
 * ```ts
 * buildImageBody(resolveArkImageModel(undefined, "intl"), "p", { size: "1440x2560", watermark: false, seed: undefined });
 * // => { model: "seedream-5-0-lite-260128", prompt: "p", size: "1440x2560", response_format: "url", watermark: false }
 * ```
 */
export function buildImageBody(
  model: ArkImageModel,
  prompt: string,
  checked: CheckedImageRequest
): ArkImageBody {
  return {
    model: model.id,
    prompt,
    size: checked.size,
    response_format: "url",
    watermark: checked.watermark,
    ...(checked.seed === undefined ? {} : { seed: checked.seed })
  };
}

/**
 * Whether the bytes start with the given signature.
 *
 * @param bytes - File bytes.
 * @param signature - Expected leading bytes.
 * @param offset - Where the signature starts.
 * @returns True on a match.
 * @example
 * ```ts
 * startsWith(new Uint8Array([0xff, 0xd8, 0xff]), [0xff, 0xd8, 0xff], 0); // => true
 * ```
 */
function startsWith(bytes: Uint8Array, signature: readonly number[], offset: number): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

/**
 * The image MIME type read from the first bytes: PNG, JPEG, GIF or WebP.
 *
 * @param bytes - File bytes.
 * @returns The MIME type, or `application/octet-stream` for anything else.
 * @example
 * ```ts
 * sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])); // => "image/jpeg"
 * ```
 */
export function sniffImageMime(bytes: Uint8Array): string {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47], 0)) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff], 0)) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38], 0)) return "image/gif";
  const isWebp =
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46], 0) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8);
  return isWebp ? "image/webp" : OCTET_STREAM;
}

/**
 * The MIME type of a downloaded image: the response's `Content-Type` when it
 * names an image, else the type read from the bytes. The bytes are never
 * changed.
 *
 * @param contentType - The `Content-Type` header, or null.
 * @param bytes - The downloaded bytes.
 * @returns The MIME type, without parameters.
 * @example
 * ```ts
 * imageMimeOf(null, new Uint8Array([0x89, 0x50, 0x4e, 0x47])); // => "image/png"
 * ```
 */
export function imageMimeOf(contentType: string | null, bytes: Uint8Array): string {
  const bare = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return bare.startsWith("image/") ? bare : sniffImageMime(bytes);
}

/**
 * Logs `ark:negative:ignored` the first time an image request carries
 * `negative` in this process: Seedream here takes no negative prompt, so it
 * is dropped.
 *
 * @param ctx - Plugin context (state, log).
 * @param model - The image model id, for the log.
 * @param request - The image request.
 */
export function warnImageNegativeOnce(
  ctx: ArkContext,
  model: string,
  request: Pick<ImageRequest, "negative">
): void {
  const hasNegative = request.negative !== undefined && request.negative !== "";
  if (!hasNegative || ctx.state.imageNegativeWarned) return;

  ctx.state.imageNegativeWarned = true;
  ctx.log.warn("ark:negative:ignored", { model });
}
