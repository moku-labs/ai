/**
 * @file fal sprite catalog — data module. Maps each matte alias to its fal
 * endpoint and body builder; `none` has no endpoint and makes no call. A
 * request is validated with zod before anything is priced, uploaded or sent:
 * the source must be a resolved file, the pixel options must be in range, and
 * the matte params must be values fal documents.
 */
import { z } from "zod";
import type { SpriteRequest } from "../../sprite/contract";
import { TerminalProviderError } from "../errors";
import type { LocalFile } from "../types";

/**
 * The BiRefNet v2 variants fal documents for its `model` field
 * (fal.ai/models/fal-ai/birefnet/v2, checked 2026-10-04).
 *
 * @example
 * ```ts
 * BIREFNET_VARIANTS[0]; // => "General Use (Light)"
 * ```
 */
export const BIREFNET_VARIANTS = [
  "General Use (Light)",
  "General Use (Light 2K)",
  "General Use (Heavy)",
  "Matting",
  "Portrait",
  "General Use (Dynamic)"
] as const;

/**
 * The BiRefNet v2 operating resolutions fal documents.
 *
 * @example
 * ```ts
 * BIREFNET_RESOLUTIONS[0]; // => "1024x1024"
 * ```
 */
export const BIREFNET_RESOLUTIONS = ["1024x1024", "2048x2048", "2304x2304"] as const;

/** The matte params a matte model reads; every other param key is ignored. */
const matteParametersSchema = z.object({
  model: z.enum(BIREFNET_VARIANTS).optional(),
  operating_resolution: z.enum(BIREFNET_RESOLUTIONS).optional()
});

/**
 * The matte params of a request, checked against the documented values.
 *
 * @example
 * ```ts
 * const params: MatteParameters = { model: "Matting", operating_resolution: "2048x2048" };
 * ```
 */
export type MatteParameters = z.infer<typeof matteParametersSchema>;

/**
 * Aliases of the models that remove the background on fal.
 *
 * @example
 * ```ts
 * const alias: MatteAlias = "birefnet";
 * ```
 */
export type MatteAlias = "birefnet";

/**
 * Sprite model aliases this plugin accepts in `SpriteRequest.model`: a
 * matte model, or `none` for a source that is already transparent.
 *
 * @example
 * ```ts
 * const alias: SpriteAlias = "none";
 * ```
 */
export type SpriteAlias = MatteAlias | "none";

/**
 * One matte catalog row.
 *
 * @example
 * ```ts
 * matteModels.birefnet.endpoint; // => "fal-ai/birefnet/v2"
 * ```
 */
export type MatteModel = {
  /** fal endpoint id. */
  endpoint: string;
  /** Builds the posted body from the uploaded source URL and the matte params. */
  body: (imageUrl: string, params: MatteParameters) => Record<string, unknown>;
};

/**
 * A resolved sprite model: a matte row with its alias, or `none`.
 *
 * @example
 * ```ts
 * resolveSpriteModel("none"); // => { alias: "none" }
 * ```
 */
export type ResolvedSpriteModel = { alias: "none" } | (MatteModel & { alias: MatteAlias });

/**
 * A request that passed every check, with what the handler reads off it.
 *
 * @example
 * ```ts
 * checkSpriteRequest({ source: file, model: "birefnet" }).params; // => {}
 * ```
 */
export type CheckedSpriteRequest = {
  /** The resolved model. */
  model: ResolvedSpriteModel;
  /** The resolved source file. */
  source: LocalFile;
  /** The matte params; empty for `none`. */
  params: MatteParameters;
};

/** The alias of the model that skips the matte. */
const NO_MATTE = "none";

/** BiRefNet variant when `params.model` is not set: fal's light general-use model. */
const DEFAULT_VARIANT = "General Use (Light)";

/** BiRefNet resolution when `params.operating_resolution` is not set. */
const DEFAULT_RESOLUTION = "1024x1024";

/** Status of a request refused before any upload or charge. */
const BAD_REQUEST = 400;

/** A resolved source file. */
const sourceSchema = z.object({
  path: z.string().min(1),
  mimeType: z.string().min(1),
  hash: z.string().min(1)
});

/** The pixel options of a sprite request, as the build item writes them. */
const requestSchema = z.object({
  model: z.string().min(1),
  trim: z.boolean().optional(),
  padding: z.number().int().min(0).optional(),
  size: z.object({ width: z.number().int().min(1), height: z.number().int().min(1) }).optional(),
  fit: z.enum(["contain", "cover", "fill"]).optional(),
  pixelArt: z.boolean().optional(),
  alphaThreshold: z.number().min(0).max(255).optional(),
  params: z.record(z.string(), z.unknown()).optional()
});

/**
 * BiRefNet v2 body: the source URL, the variant and resolution (defaults
 * or the matte params), a PNG output and a refined foreground.
 *
 * @param imageUrl - The uploaded source URL (or data URI).
 * @param params - The checked matte params.
 * @returns The posted body.
 * @example
 * ```ts
 * birefnetBody("https://cdn/raw.png", {}).model; // => "General Use (Light)"
 * ```
 */
function birefnetBody(imageUrl: string, params: MatteParameters): Record<string, unknown> {
  return {
    image_url: imageUrl,
    model: params.model ?? DEFAULT_VARIANT,
    operating_resolution: params.operating_resolution ?? DEFAULT_RESOLUTION,
    output_format: "png",
    refine_foreground: true
  };
}

/**
 * The fal matte catalog, in the order `models("sprite")` lists it (`none` follows).
 *
 * @example
 * ```ts
 * matteModels.birefnet.endpoint; // => "fal-ai/birefnet/v2"
 * ```
 */
export const matteModels: Readonly<Record<MatteAlias, MatteModel>> = {
  birefnet: { endpoint: "fal-ai/birefnet/v2", body: birefnetBody }
};

/**
 * Whether `model` is one of the matte catalog's own aliases.
 *
 * @param model - The requested model string.
 * @returns True for a known matte alias.
 * @example
 * ```ts
 * isMatteAlias("rembg"); // => false
 * ```
 */
function isMatteAlias(model: string): model is MatteAlias {
  return Object.hasOwn(matteModels, model);
}

/**
 * The accepted aliases, in catalog order: the matte models, then `none`.
 *
 * @returns Alias list.
 * @example
 * ```ts
 * spriteAliases(); // => ["birefnet", "none"]
 * ```
 */
export function spriteAliases(): SpriteAlias[] {
  const matte = Object.keys(matteModels).filter(alias => isMatteAlias(alias));
  return [...matte, NO_MATTE];
}

/**
 * Resolves a model alias. The only check `estimate` makes: the runner
 * estimates before the source is resolved.
 *
 * @param model - `SpriteRequest.model`.
 * @returns The matte row with its alias, or `{ alias: "none" }`.
 * @throws {TerminalProviderError} A 400 for an unknown alias.
 * @example
 * ```ts
 * resolveSpriteModel("birefnet").alias; // => "birefnet"
 * ```
 */
export function resolveSpriteModel(model: string): ResolvedSpriteModel {
  if (model === NO_MATTE) return { alias: NO_MATTE };
  if (isMatteAlias(model)) return { ...matteModels[model], alias: model };
  throw new TerminalProviderError(
    `[ai] Unknown fal sprite model "${model}".\n  Use one of: ${spriteAliases().join(", ")}.`,
    BAD_REQUEST
  );
}

/**
 * The first zod issue as `<field> <message>`, with the parsed value's path prefix.
 *
 * @param error - The zod error of the failed parse.
 * @param prefix - Path prefix of the parsed value, e.g. "params.".
 * @returns The detail for {@link invalidRequest}.
 * @example
 * ```ts
 * issueDetail(z.object({ fit: z.boolean() }).safeParse({ fit: 1 }).error, ""); // => "fit Invalid input: expected boolean, received number"
 * ```
 */
function issueDetail(error: z.ZodError, prefix: string): string {
  const issue = error.issues[0];
  const where = issue === undefined ? "request" : `${prefix}${issue.path.map(String).join(".")}`;
  return `${where} ${issue?.message ?? "is invalid"}`;
}

/**
 * The terminal 400 of an invalid request.
 *
 * @param detail - What is wrong, naming the field.
 * @returns The error to throw.
 * @example
 * ```ts
 * invalidRequest("padding is negative").message; // => "[ai] Invalid sprite request: padding is negative.\n  Fix the build item that produced it."
 * ```
 */
function invalidRequest(detail: string): TerminalProviderError {
  return new TerminalProviderError(
    `[ai] Invalid sprite request: ${detail}.\n  Fix the build item that produced it.`,
    BAD_REQUEST
  );
}

/**
 * Validates a sprite request: the model alias, a resolved source, the pixel
 * options (zod, the issue path names the bad field) and, for a matte model,
 * the matte params. `none` reads no params.
 *
 * @param request - The request as the build item wrote it.
 * @returns The resolved model, the source file and the matte params.
 * @throws {TerminalProviderError} A 400 for an unknown alias, an unresolved source, a bad option or a bad matte param.
 * @example
 * ```ts
 * checkSpriteRequest({ source: { $ref: "btn-raw" }, model: "birefnet" }); // throws: fal sprite got an unresolved source
 * ```
 */
export function checkSpriteRequest(request: SpriteRequest): CheckedSpriteRequest {
  // The alias first: there is no fallback to another model.
  const model = resolveSpriteModel(request.model);

  // The source must be a stored file: a `$ref` / `$file` is resolved by the runner.
  const source = sourceSchema.safeParse(request.source);
  if (!source.success) {
    throw new TerminalProviderError(
      "[ai] fal sprite got an unresolved source.\n  Run the item through app.runner, or pass a { path, mimeType, hash } file.",
      BAD_REQUEST
    );
  }

  // The pixel options, by zod, so a bad one is refused before the matte is paid for.
  const options = requestSchema.safeParse(request);
  if (!options.success) throw invalidRequest(issueDetail(options.error, ""));
  if (model.alias === NO_MATTE) return { model, source: source.data, params: {} };

  // The matte params, against the values fal documents.
  const params = matteParametersSchema.safeParse(request.params ?? {});
  if (!params.success) throw invalidRequest(issueDetail(params.error, "params."));
  return { model, source: source.data, params: params.data };
}
