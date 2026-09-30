/**
 * @file fal image catalog — data module. Maps each accepted model alias to its
 * text and edit endpoints, reference limit, aspects, resolution mapping, size
 * tables and body builder. A request with refs goes to the edit endpoint.
 */
import { TerminalProviderError } from "../errors";

/**
 * Image model aliases this plugin accepts in `ImageRequest.model`.
 *
 * @example
 * ```ts
 * const alias: ImageAlias = "nano-banana-pro";
 * ```
 */
export type ImageAlias = "nano-banana-pro" | "seedream-4.5-edit" | "gpt-image-2.5";

/**
 * Pixel size of an output image, as fal's `image_size` object.
 *
 * @example
 * ```ts
 * const size: ImageSize = { width: 1152, height: 2048 };
 * ```
 */
export type ImageSize = {
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
  height: number;
};

/**
 * Everything a body builder needs, already planned: prompt with the
 * negative appended, aspect, resolution, uploaded ref URLs and quality.
 *
 * @example
 * ```ts
 * const input: ImageBodyInput = { prompt: "hero", aspect: "9:16", resolution: "2K", imageUrls: [], quality: undefined, outputFormat: undefined };
 * ```
 */
export type ImageBodyInput = {
  /** Prompt as sent. */
  prompt: string;
  /** Aspect ratio, checked against the model. */
  aspect: string;
  /** Planned resolution (`1K`/`2K`/`4K` native, `2K`/`1080` sized), or undefined. */
  resolution: string | undefined;
  /** Uploaded ref URLs (or data URIs), in request order. */
  imageUrls: readonly string[];
  /** `params.quality` when it is a string (gpt-image only). */
  quality: string | undefined;
  /** `params.output_format` when it is a string: gpt-image maps it, nano keeps png, seedream gets it as a pass-through param. */
  outputFormat: string | undefined;
};

/**
 * One catalog row.
 *
 * @example
 * ```ts
 * resolveImageModel("gpt-image-2.5").maxRefs; // => 16
 * ```
 */
export type ImageModel = {
  /** Endpoint without refs. */
  textEndpoint: string;
  /** Endpoint with refs. */
  editEndpoint: string;
  /** Most reference images one request takes. */
  maxRefs: number;
  /** Aspect ratios the model takes without a size table. */
  aspects: readonly string[];
  /** Planned resolution by asked `params.resolution`; an asked value missing here is ignored. */
  resolutions: Readonly<Record<string, string>>;
  /** Planned resolution when `params.resolution` is not set. */
  defaultResolution: string | undefined;
  /** Size tables by planned resolution; they limit the aspects at that resolution. */
  sizeTables: Readonly<Record<string, Readonly<Record<string, ImageSize | string>>>>;
  /** Builds the mapped body fields. */
  body: (input: ImageBodyInput) => Record<string, unknown>;
};

/**
 * A catalog row with its alias.
 *
 * @example
 * ```ts
 * resolveImageModel("seedream-4.5-edit").alias; // => "seedream-4.5-edit"
 * ```
 */
export type ResolvedImageModel = ImageModel & { alias: ImageAlias };

/**
 * Default aspect when `ImageRequest.aspect` is omitted.
 *
 * @example
 * ```ts
 * DEFAULT_IMAGE_ASPECT; // => "9:16"
 * ```
 */
export const DEFAULT_IMAGE_ASPECT = "9:16";

/**
 * Every `params.resolution` value a model accepts; each model maps or ignores it.
 *
 * @example
 * ```ts
 * IMAGE_RESOLUTIONS.includes("1080"); // => true
 * ```
 */
export const IMAGE_RESOLUTIONS: readonly string[] = ["1K", "2K", "4K", "1080"];

/** Status of a request refused before any upload or charge. */
const BAD_REQUEST = 400;

/** Nano Banana Pro aspect ratios. */
const NANO_ASPECTS: readonly string[] = [
  "21:9",
  "16:9",
  "3:2",
  "4:3",
  "5:4",
  "1:1",
  "4:5",
  "3:4",
  "2:3",
  "9:16"
];

/** Seedream 4.5 default output size by aspect. */
const SEEDREAM_SIZES: Readonly<Record<string, ImageSize>> = {
  "9:16": { width: 1440, height: 2560 },
  "16:9": { width: 2560, height: 1440 },
  "1:1": { width: 1920, height: 1920 },
  "3:4": { width: 1920, height: 2560 },
  "4:3": { width: 2560, height: 1920 }
};

/** fal's named size presets, used by Seedream and GPT Image at `1080`. */
const PRESET_SIZES: Readonly<Record<string, string>> = {
  "9:16": "portrait_16_9",
  "16:9": "landscape_16_9",
  "1:1": "square_hd",
  "3:4": "portrait_4_3",
  "4:3": "landscape_4_3"
};

/** GPT Image 2.5 output size by aspect at `2K`. */
const GPT_2K_SIZES: Readonly<Record<string, ImageSize>> = {
  "9:16": { width: 1152, height: 2048 },
  "16:9": { width: 2048, height: 1152 },
  "1:1": { width: 2048, height: 2048 },
  "3:4": { width: 1536, height: 2048 },
  "4:3": { width: 2048, height: 1536 }
};

/** Seedream's own size for `2K`: fal picks the 2K size of the aspect. */
const SEEDREAM_2K_SIZE = "auto_2K";

/** GPT Image qualities fal accepts (fal schema, checked 2026-09-30). */
const GPT_QUALITIES: ReadonlySet<string> = new Set([
  "auto",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);

/** GPT Image output formats fal accepts (fal schema, checked 2026-09-30). */
const GPT_OUTPUT_FORMATS: ReadonlySet<string> = new Set(["jpeg", "png", "webp"]);

/** GPT Image output format when `params.output_format` is not one of {@link GPT_OUTPUT_FORMATS}. */
const DEFAULT_GPT_OUTPUT_FORMAT = "jpeg";

/** GPT Image quality when `params.quality` is not one of {@link GPT_QUALITIES}. */
const DEFAULT_GPT_QUALITY = "high";

/** Resolutions sized by Seedream and GPT Image; `1K` and `4K` are ignored. */
const SIZED_RESOLUTIONS: Readonly<Record<string, string>> = { "2K": "2K", "1080": "1080" };

/**
 * `image_urls` when the request has refs, else nothing.
 *
 * @param imageUrls - Uploaded ref URLs.
 * @returns The field, or an empty object.
 * @example
 * ```ts
 * imageUrlsField(["u"]); // => { image_urls: ["u"] }
 * ```
 */
function imageUrlsField(imageUrls: readonly string[]): { image_urls?: readonly string[] } {
  return imageUrls.length > 0 ? { image_urls: imageUrls } : {};
}

/**
 * Nano Banana Pro body: aspect ratio and native resolution, one PNG.
 *
 * @param input - Planned fields.
 * @returns The mapped body.
 * @example
 * ```ts
 * nanoBananaBody({ prompt: "p", aspect: "9:16", resolution: "1K", imageUrls: [], quality: undefined, outputFormat: undefined }).resolution; // => "1K"
 * ```
 */
function nanoBananaBody(input: ImageBodyInput): Record<string, unknown> {
  return {
    prompt: input.prompt,
    aspect_ratio: input.aspect,
    resolution: input.resolution,
    num_images: 1,
    output_format: "png",
    enable_web_search: false,
    sync_mode: false,
    ...imageUrlsField(input.imageUrls)
  };
}

/**
 * Seedream `image_size`: `auto_2K` at 2K, the preset name at 1080, else the default size.
 *
 * @param aspect - Checked aspect ratio.
 * @param resolution - Planned resolution.
 * @returns The size object or preset name.
 * @example
 * ```ts
 * seedreamSize("9:16", "1080"); // => "portrait_16_9"
 * ```
 */
function seedreamSize(
  aspect: string,
  resolution: string | undefined
): ImageSize | string | undefined {
  if (resolution === "2K") return SEEDREAM_2K_SIZE;
  if (resolution === "1080") return PRESET_SIZES[aspect];
  return SEEDREAM_SIZES[aspect];
}

/**
 * Seedream 4.5 body: `image_size` from the resolution, one image.
 *
 * @param input - Planned fields.
 * @returns The mapped body.
 * @example
 * ```ts
 * seedreamBody({ prompt: "p", aspect: "1:1", resolution: "2K", imageUrls: [], quality: undefined, outputFormat: undefined }).image_size; // => "auto_2K"
 * ```
 */
function seedreamBody(input: ImageBodyInput): Record<string, unknown> {
  return {
    prompt: input.prompt,
    image_size: seedreamSize(input.aspect, input.resolution),
    num_images: 1,
    max_images: 1,
    sync_mode: false,
    ...imageUrlsField(input.imageUrls)
  };
}

/**
 * GPT Image 2.5 body: the 2K size object or the preset name, quality, one
 * image in the caller's `output_format`, JPEG by default.
 *
 * @param input - Planned fields.
 * @returns The mapped body.
 * @example
 * ```ts
 * gptImageBody({ prompt: "p", aspect: "9:16", resolution: undefined, imageUrls: [], quality: "ultra", outputFormat: "png" }).output_format; // => "png"
 * ```
 */
function gptImageBody(input: ImageBodyInput): Record<string, unknown> {
  const sizes = input.resolution === "2K" ? GPT_2K_SIZES : PRESET_SIZES;
  const hasKnownQuality = input.quality !== undefined && GPT_QUALITIES.has(input.quality);
  const quality = hasKnownQuality ? input.quality : DEFAULT_GPT_QUALITY;
  const hasKnownFormat =
    input.outputFormat !== undefined && GPT_OUTPUT_FORMATS.has(input.outputFormat);
  const outputFormat = hasKnownFormat ? input.outputFormat : DEFAULT_GPT_OUTPUT_FORMAT;
  return {
    prompt: input.prompt,
    image_size: sizes[input.aspect],
    quality,
    num_images: 1,
    output_format: outputFormat,
    ...imageUrlsField(input.imageUrls)
  };
}

/**
 * The fal image catalog, in the order `models("image")` lists it.
 *
 * @example
 * ```ts
 * imageModels["nano-banana-pro"].editEndpoint; // => "fal-ai/nano-banana-pro/edit"
 * ```
 */
export const imageModels: Readonly<Record<ImageAlias, ImageModel>> = {
  "nano-banana-pro": {
    textEndpoint: "fal-ai/nano-banana-pro",
    editEndpoint: "fal-ai/nano-banana-pro/edit",
    maxRefs: 14,
    aspects: NANO_ASPECTS,
    resolutions: { "1K": "1K", "2K": "2K", "4K": "4K", "1080": "1K" },
    defaultResolution: "1K",
    sizeTables: {},
    body: nanoBananaBody
  },
  "seedream-4.5-edit": {
    textEndpoint: "fal-ai/bytedance/seedream/v4.5/text-to-image",
    editEndpoint: "fal-ai/bytedance/seedream/v4.5/edit",
    maxRefs: 10,
    aspects: Object.keys(SEEDREAM_SIZES),
    resolutions: SIZED_RESOLUTIONS,
    defaultResolution: undefined,
    sizeTables: { "1080": PRESET_SIZES },
    body: seedreamBody
  },
  "gpt-image-2.5": {
    textEndpoint: "openai/gpt-image-2.5/sunburst/text-to-image",
    editEndpoint: "openai/gpt-image-2.5/sunburst/edit",
    maxRefs: 16,
    aspects: Object.keys(PRESET_SIZES),
    resolutions: SIZED_RESOLUTIONS,
    defaultResolution: undefined,
    sizeTables: { "2K": GPT_2K_SIZES, "1080": PRESET_SIZES },
    body: gptImageBody
  }
};

/**
 * The accepted aliases, in catalog order.
 *
 * @returns Alias list.
 * @example
 * ```ts
 * imageAliases(); // => ["nano-banana-pro", "seedream-4.5-edit", "gpt-image-2.5"]
 * ```
 */
export function imageAliases(): ImageAlias[] {
  return Object.keys(imageModels).filter(alias => isImageAlias(alias));
}

/**
 * Whether `model` is one of the catalog's own aliases.
 *
 * @param model - The requested model string.
 * @returns True for a known alias.
 * @example
 * ```ts
 * isImageAlias("gpt-image-2.5"); // => true
 * ```
 */
function isImageAlias(model: string): model is ImageAlias {
  return Object.hasOwn(imageModels, model);
}

/**
 * Looks up the catalog row for `model`.
 *
 * @param model - The requested model string.
 * @returns The row and its alias.
 * @throws {TerminalProviderError} A 400 listing the aliases for an unknown model.
 * @example
 * ```ts
 * resolveImageModel("nano-banana-pro").textEndpoint; // => "fal-ai/nano-banana-pro"
 * ```
 */
export function resolveImageModel(model: string): ResolvedImageModel {
  if (!isImageAlias(model)) {
    throw new TerminalProviderError(
      `[ai] Unknown fal image model "${model}".\n  Use one of: ${imageAliases().join(", ")}.`,
      BAD_REQUEST
    );
  }
  return { ...imageModels[model], alias: model };
}

/**
 * The planned resolution: the model's default without `params.resolution`;
 * otherwise one of {@link IMAGE_RESOLUTIONS}, mapped by the model (a value the
 * model does not map is ignored).
 *
 * @param model - The resolved row.
 * @param asked - `params.resolution`, untrusted.
 * @returns The planned resolution, or undefined.
 * @throws {TerminalProviderError} A 400 for a value outside {@link IMAGE_RESOLUTIONS}.
 * @example
 * ```ts
 * imageResolution(resolveImageModel("nano-banana-pro"), "1080"); // => "1K"
 * ```
 */
export function imageResolution(model: ImageModel, asked: unknown): string | undefined {
  if (asked === undefined) return model.defaultResolution;

  const resolution = typeof asked === "string" ? asked : JSON.stringify(asked);
  if (!IMAGE_RESOLUTIONS.includes(resolution)) {
    throw new TerminalProviderError(
      `[ai] fal image resolution "${resolution}" is not supported.\n  Use one of: ${IMAGE_RESOLUTIONS.join(", ")}.`,
      BAD_REQUEST
    );
  }
  return Object.hasOwn(model.resolutions, resolution) ? model.resolutions[resolution] : undefined;
}

/**
 * Checks the aspect against the size table of the planned resolution when
 * the model has one, else against the model's aspects.
 *
 * @param model - The resolved row.
 * @param aspect - The requested aspect.
 * @param resolution - The planned resolution.
 * @returns {void} Nothing; an aspect the model takes passes.
 * @throws {TerminalProviderError} A 400 listing the aspects the model takes.
 * @example
 * ```ts
 * checkImageAspect(resolveImageModel("gpt-image-2.5"), "21:9", "2K"); // throws: '[ai] fal image model "gpt-image-2.5" does not support aspect "21:9".\n  Use one of: 9:16, 16:9, 1:1, 3:4, 4:3.'
 * ```
 */
export function checkImageAspect(
  model: ResolvedImageModel,
  aspect: string,
  resolution: string | undefined
): void {
  const table = resolution === undefined ? undefined : model.sizeTables[resolution];
  const aspects = table === undefined ? model.aspects : Object.keys(table);
  if (aspects.includes(aspect)) return;

  throw new TerminalProviderError(
    `[ai] fal image model "${model.alias}" does not support aspect "${aspect}".\n  Use one of: ${aspects.join(", ")}.`,
    BAD_REQUEST
  );
}

/**
 * The prompt as sent: the negative prompt appended as an `Avoid:` line.
 *
 * @param prompt - What to draw.
 * @param negative - What to avoid, if any.
 * @returns The prompt.
 * @example
 * ```ts
 * promptWithNegative("hero", "blur"); // => "hero\n\nAvoid: blur"
 * ```
 */
export function promptWithNegative(prompt: string, negative: string | undefined): string {
  return negative === undefined || negative === "" ? prompt : `${prompt}\n\nAvoid: ${negative}`;
}
