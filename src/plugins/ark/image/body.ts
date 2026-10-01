/**
 * @file ark image body — maps an `ImageRequest` plus `params` to the Seedream
 * body (`POST {base}/images/generations`). `checkImageRequest` refuses what
 * Seedream here cannot take (no I/O): too many refs, unknown params, an
 * unknown aspect, a size below the model's minimum. `readReferenceImages` reads the
 * local refs as data URIs. `buildImageBody` assembles the body (pure).
 * `imageMimeOf` names the downloaded bytes without touching them: ark trusts
 * a face only in the original bytes.
 */
import { readFile } from "node:fs/promises";
import type { ImageFile, ImageRequest } from "../../image/contract";
import { readString } from "../client";
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
  /** Reference images as data URIs: a string for one, an array for several. Absent without refs. */
  image?: string | string[];
};

/**
 * An image request checked against the model, with defaults applied.
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

/** PNG file signature: `\x89PNG`. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47] as const;

/** JPEG file signature: the SOI marker and the next marker byte. */
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;

/** GIF file signature: `GIF8`. */
const GIF_SIGNATURE = [0x47, 0x49, 0x46, 0x38] as const;

/** RIFF container signature: `RIFF`, the start of a WebP file. */
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46] as const;

/** WebP form type: `WEBP`, after the RIFF chunk size. */
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50] as const;

/** Where `WEBP` starts in a RIFF file: after `RIFF` and the 4-byte chunk size. */
const WEBP_TAG_OFFSET = 8;

/** The error for a ref the runner did not resolve to a local file. */
const UNRESOLVED_REF_ERROR =
  "[ai] ark image got an unresolved reference.\n  Run the item through app.runner, or pass { path, mimeType, hash } files.";

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
  const isKnownAspect = aspect !== undefined && ARK_IMAGE_SIZES[aspect] !== undefined;
  const hintAspect = isKnownAspect ? aspect : DEFAULT_ASPECT;
  throw new Error(
    `[ai] ark image size ${match[0]} is below ${model.minPixels} pixels.\n  Use at least ${ARK_IMAGE_SIZES[hintAspect]} for ${hintAspect}.`
  );
}

/**
 * Refuses more refs than the model takes. Only the count is read: refs may
 * still be unresolved `$ref`s at estimate time.
 *
 * @param model - The image catalog row.
 * @param referenceCount - How many refs the request has.
 * @throws {Error} A plain two-line error naming the limit and the count.
 * @example
 * ```ts
 * checkReferenceCount(resolveArkImageModel(undefined, "intl"), 15);
 * // throws: '[ai] ark image model "seedream-5-0-lite-260128" takes at most 14 reference images, got 15.\n  Remove refs from input.refs.'
 * ```
 */
function checkReferenceCount(model: ArkImageModel, referenceCount: number): void {
  if (referenceCount <= model.maxRefImages) return;
  throw new Error(
    `[ai] ark image model "${model.id}" takes at most ${model.maxRefImages} reference images, got ${referenceCount}.\n  Remove refs from input.refs.`
  );
}

/**
 * Checks an image request against the model, with no I/O: at most the model's refs, known
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
  checkReferenceCount(model, request.refs?.length ?? 0);

  const params = request.params ?? {};
  checkImageParameters(params);
  const size =
    params.size === undefined
      ? sizeOfAspect(request.aspect)
      : checkSize(model, params.size, request.aspect);
  return { size, watermark: params.watermark ?? false, seed: params.seed };
}

/**
 * Whether a ref is a resolved local file.
 *
 * @param value - One entry of `request.refs`.
 * @returns True for `{ path, mimeType, hash }`.
 * @example
 * ```ts
 * isImageFile({ $ref: "e01.face" }); // => false
 * ```
 */
function isImageFile(value: unknown): value is ImageFile {
  return (
    readString(value, "path") !== undefined &&
    readString(value, "mimeType") !== undefined &&
    readString(value, "hash") !== undefined
  );
}

/**
 * Reads one ref as a data URI. Ark wants the format in lowercase.
 *
 * @param file - A resolved ref.
 * @returns `data:<mime>;base64,<bytes>`.
 * @throws {Error} A plain two-line error when the file cannot be read.
 */
async function readReferenceImage(file: ImageFile): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(file.path));
  } catch {
    throw new Error(
      `[ai] Cannot read ark image ref "${file.path}".\n  Check that the $ref or $file it came from still exists.`
    );
  }
  return `data:${file.mimeType.toLowerCase()};base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * Reads the refs as data URIs, in request order. No public hosting needed.
 *
 * @param references - `request.refs`; every one must be resolved.
 * @returns The data URIs; empty without refs.
 * @throws {Error} A plain two-line error for an unresolved or unreadable ref.
 * @example
 * ```ts
 * await readReferenceImages([{ path: "face.png", mimeType: "image/png", hash: "h" }]);
 * // => ["data:image/png;base64,..."]
 * ```
 */
export async function readReferenceImages(references: readonly unknown[]): Promise<string[]> {
  if (!references.every(reference => isImageFile(reference))) {
    throw new Error(UNRESOLVED_REF_ERROR);
  }
  return Promise.all(references.map(reference => readReferenceImage(reference)));
}

/**
 * Assembles the Seedream body: one image by URL, `watermark` false by default,
 * the seed only when given. Refs go in `image`: a string for one, an array for
 * several, absent without refs, so text-to-image keeps its body.
 *
 * @param model - The image catalog row.
 * @param prompt - The prompt, sent as given.
 * @param checked - The checked request.
 * @param images - The refs as data URIs, from {@link readReferenceImages}.
 * @returns The body.
 * @example
 * ```ts
 * buildImageBody(resolveArkImageModel(undefined, "intl"), "p", { size: "1440x2560", watermark: false, seed: undefined }, []);
 * // => { model: "seedream-5-0-lite-260128", prompt: "p", size: "1440x2560", response_format: "url", watermark: false }
 * ```
 */
export function buildImageBody(
  model: ArkImageModel,
  prompt: string,
  checked: CheckedImageRequest,
  images: readonly string[]
): ArkImageBody {
  const [first, ...rest] = images;
  const image = rest.length === 0 ? first : [...images];
  return {
    model: model.id,
    prompt,
    size: checked.size,
    response_format: "url",
    watermark: checked.watermark,
    ...(checked.seed === undefined ? {} : { seed: checked.seed }),
    ...(image === undefined ? {} : { image })
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
  if (startsWith(bytes, PNG_SIGNATURE, 0)) return "image/png";
  if (startsWith(bytes, JPEG_SIGNATURE, 0)) return "image/jpeg";
  if (startsWith(bytes, GIF_SIGNATURE, 0)) return "image/gif";
  const isWebp =
    startsWith(bytes, RIFF_SIGNATURE, 0) && startsWith(bytes, WEBP_SIGNATURE, WEBP_TAG_OFFSET);
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
