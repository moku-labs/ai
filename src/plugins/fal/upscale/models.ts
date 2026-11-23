/**
 * @file fal upscale catalog — data module. Maps each accepted model alias to its
 * endpoint and the body fields a build item cannot change, and validates a
 * request with zod before anything is priced, uploaded or sent. There is no
 * automatic fallback between the models: the request names one, and only that
 * one runs.
 */
import { z } from "zod";
import type { UpscaleEstimateRequest, UpscaleRequest } from "../../upscale/contract";
import { TerminalProviderError } from "../errors";

/**
 * Upscale model aliases this plugin accepts in `UpscaleRequest.model`.
 *
 * @example
 * ```ts
 * const alias: UpscaleAlias = "starlight-fast-2";
 * ```
 */
export type UpscaleAlias = "starlight-fast-2" | "starlight-precise-2.6" | "proteus";

/**
 * One catalog row: plain data.
 *
 * @example
 * ```ts
 * upscaleModels.proteus.endpoint; // => "fal-ai/topaz/upscale/video"
 * ```
 */
export type UpscaleModel = {
  /** fal endpoint id. */
  endpoint: string;
  /** Body fields that always win over `params`: a build item cannot flip them. */
  fixed: Readonly<Record<string, unknown>>;
};

/**
 * A catalog row with its alias and its body builder.
 *
 * @example
 * ```ts
 * checkUpscaleEstimate({ video: { $ref: "clean" }, model: "proteus", factor: 2, seconds: 10 }).model.alias; // => "proteus"
 * ```
 */
export type ResolvedUpscaleModel = UpscaleModel & {
  /** The model alias. */
  alias: UpscaleAlias;
  /** Builds the posted body without `video_url`, which is added at submit. */
  body: (request: UpscaleEstimateRequest) => Record<string, unknown>;
};

/** Status of a request refused before any charge. */
const BAD_REQUEST = 400;

/** Smallest and largest upscale factor fal's Topaz endpoints take. */
const FACTOR_RANGE = { min: 1, max: 4 };

/** MIME type prefix every input video carries. */
const VIDEO_MIME_PREFIX = "video/";

/** The fields of an upscale request that need no resolved file: what the estimate checks. */
const estimateShape = {
  model: z.string().min(1),
  factor: z.number().min(FACTOR_RANGE.min).max(FACTOR_RANGE.max),
  seconds: z.number().positive(),
  params: z.record(z.string(), z.unknown()).optional()
};

/** An estimate request, as the build item writes it; `video` may still be a reference, so it is not read. */
const estimateSchema = z.object(estimateShape);

/** A full request: the estimate fields plus a resolved local video. */
const requestSchema = z.object({
  ...estimateShape,
  video: z.object({
    path: z.string().min(1),
    mimeType: z.string().startsWith(VIDEO_MIME_PREFIX),
    hash: z.string().min(1)
  })
});

/**
 * The fal upscale catalog, in the order `models("upscale")` lists it.
 *
 * @example
 * ```ts
 * upscaleModels["starlight-fast-2"].fixed; // => { model: "Starlight Fast 2", H264_output: true }
 * ```
 */
export const upscaleModels: Readonly<Record<UpscaleAlias, UpscaleModel>> = {
  "starlight-fast-2": {
    endpoint: "topaz/upscale/video/generative",
    fixed: { model: "Starlight Fast 2", H264_output: true }
  },
  "starlight-precise-2.6": {
    endpoint: "topaz/upscale/video/generative",
    fixed: { model: "Starlight Precise 2.6", H264_output: true }
  },
  proteus: {
    endpoint: "fal-ai/topaz/upscale/video",
    fixed: { H264_output: true }
  }
};

/**
 * Whether `model` is one of the catalog's own aliases.
 *
 * @param model - The requested model string.
 * @returns True for a known alias.
 * @example
 * ```ts
 * isUpscaleAlias("topaz"); // => false
 * ```
 */
function isUpscaleAlias(model: string): model is UpscaleAlias {
  return Object.hasOwn(upscaleModels, model);
}

/**
 * The accepted aliases, in catalog order.
 *
 * @returns Alias list.
 * @example
 * ```ts
 * upscaleAliases(); // => ["starlight-fast-2", "starlight-precise-2.6", "proteus"]
 * ```
 */
export function upscaleAliases(): UpscaleAlias[] {
  return Object.keys(upscaleModels).filter(alias => isUpscaleAlias(alias));
}

/**
 * The terminal 400 of an invalid request.
 *
 * @param detail - What is wrong, naming the field.
 * @returns The error to throw.
 * @example
 * ```ts
 * invalidRequest("factor must be at most 4").message; // => "[ai] Invalid upscale request: factor must be at most 4.\n  Fix the build item that produced it."
 * ```
 */
function invalidRequest(detail: string): TerminalProviderError {
  return new TerminalProviderError(
    `[ai] Invalid upscale request: ${detail}.\n  Fix the build item that produced it.`,
    BAD_REQUEST
  );
}

/**
 * Reads the catalog row of a request's model alias.
 *
 * @param alias - `request.model`.
 * @returns The row with its alias and body builder.
 * @throws {TerminalProviderError} A 400 listing the aliases when the model is not in the catalog.
 * @example
 * ```ts
 * resolveUpscaleModel("proteus").endpoint; // => "fal-ai/topaz/upscale/video"
 * ```
 */
function resolveUpscaleModel(alias: string): ResolvedUpscaleModel {
  // The alias must be in the catalog: there is no fallback to another model.
  if (!isUpscaleAlias(alias)) {
    throw new TerminalProviderError(
      `[ai] Unknown fal upscale model "${alias}".\n  Use one of: ${upscaleAliases().join(", ")}.`,
      BAD_REQUEST
    );
  }

  // Caller params go first so the fixed fields and the factor win.
  const row = upscaleModels[alias];
  return {
    ...row,
    alias,
    body: request => ({ ...request.params, ...row.fixed, upscale_factor: request.factor })
  };
}

/**
 * Throws the 400 of the first zod issue, naming its field.
 *
 * @param issues - The issues of a failed parse.
 * @returns {never} Always throws.
 * @throws {TerminalProviderError} A 400 naming the bad field.
 * @example
 * ```ts
 * refuseShape([{ path: ["factor"], message: "Too small" }]); // throws: [ai] Invalid upscale request: factor Too small.
 * ```
 */
function refuseShape(issues: readonly { path: readonly PropertyKey[]; message: string }[]): never {
  const [issue] = issues;
  const where = issue?.path.map(String).join(".") || "request";
  throw invalidRequest(`${where} ${issue?.message ?? "is invalid"}`);
}

/**
 * Validates an estimate-time request: the shape of `model`, `factor`, `seconds`
 * and `params` (zod, the issue path names the bad field), then the model alias.
 * `video` is not read: at plan time it may still be `{ $ref }` or `{ $file }`.
 *
 * @param request - The request as the build item wrote it.
 * @returns The resolved model and the request.
 * @throws {TerminalProviderError} A 400 for a bad field or an unknown alias.
 * @example
 * ```ts
 * checkUpscaleEstimate({ video: { $ref: "clean" }, model: "proteus", factor: 5, seconds: 10 }); // throws: factor Too big: expected number to be <=4
 * ```
 */
export function checkUpscaleEstimate(request: UpscaleEstimateRequest): {
  model: ResolvedUpscaleModel;
  request: UpscaleEstimateRequest;
} {
  const parsed = estimateSchema.safeParse(request);
  if (!parsed.success) refuseShape(parsed.error.issues);
  return { model: resolveUpscaleModel(request.model), request };
}

/**
 * Validates a submit-time request: everything the estimate checks, plus a
 * resolved `video` of non-empty `path` and `hash` whose `mimeType` starts with
 * `video/`.
 *
 * @param request - The request with its resolved video.
 * @returns The resolved model and the request.
 * @throws {TerminalProviderError} A 400 for a bad field, a non-video input or an unknown alias.
 * @example
 * ```ts
 * checkUpscaleRequest({ video: { path: "a.png", mimeType: "image/png", hash: "h" }, model: "proteus", factor: 2, seconds: 5 }); // throws: video.mimeType Invalid string: must start with "video/"
 * ```
 */
export function checkUpscaleRequest(request: UpscaleRequest): {
  model: ResolvedUpscaleModel;
  request: UpscaleRequest;
} {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) refuseShape(parsed.error.issues);
  return { model: resolveUpscaleModel(request.model), request };
}
