/**
 * @file fal model catalog — data module. Maps each accepted model alias to
 * its fal endpoint, default resolution, audio capability, reference-image
 * limit and request-body builder. `request.params` is merged last, so a
 * build file can pass any extra fal field through.
 */
import type { VideoRequest } from "../video/contract";

/**
 * A model alias this plugin accepts in `request.model`.
 *
 * @example
 * ```ts
 * const alias: FalAlias = "minimax-h3";
 * ```
 */
export type FalAlias =
  | "seedance-2.5"
  | "seedance-2.5-ref"
  | "minimax-h3"
  | "minimax-h3-max-ref"
  | "kling-3-pro"
  | "kling-o3-ref"
  | "seedance-2.0-mini"
  | "seedance-2.0-mini-ref"
  | "seedance-2.0-ref"
  | "wan-3.0-ref"
  | "veo-3.1-fast"
  | "vidu-q3"
  | "vidu-q3-ref";

/**
 * Everything a body builder needs, already resolved: uploaded URLs,
 * defaulted seconds/aspect, the effective resolution and audio flag.
 *
 * @example
 * ```ts
 * const input: BodyInput = {
 *   prompt: "push-in", imageUrl: "https://cdn/a.png", refUrls: [], audioRefUrls: [], seconds: 5,
 *   resolution: "768P", aspect: "9:16", audio: false, negative: undefined
 * };
 * ```
 */
export type BodyInput = {
  /** Motion and scene prompt. */
  prompt: string;
  /** URL (or data URI) of the first frame. */
  imageUrl: string;
  /** URLs (or data URIs) of the reference images, already checked against the model's limit. */
  refUrls: string[];
  /** URLs (or data URIs) of the reference audio files, already checked against the model's limit. */
  audioRefUrls: string[];
  /** Clip length in seconds. */
  seconds: number;
  /** Effective resolution, or undefined when the model takes none. */
  resolution: string | undefined;
  /** Aspect ratio. */
  aspect: string;
  /** Whether to generate native audio. */
  audio: boolean;
  /** Negative prompt, when given. */
  negative: string | undefined;
};

/**
 * Request body of `bytedance/seedance-2.5/image-to-video`.
 *
 * @example
 * ```ts
 * const body: SeedanceImageBody = { prompt: "p", image_url: "u", duration: "5", resolution: "720p", generate_audio: false };
 * ```
 */
export type SeedanceImageBody = {
  prompt: string;
  image_url: string;
  duration: string;
  resolution: string;
  generate_audio: boolean;
};

/**
 * Request body of `bytedance/seedance-2.5/reference-to-video`, also sent to
 * the Seedance 2.0 and 2.0 Mini reference-to-video endpoints.
 *
 * @example
 * ```ts
 * const body: SeedanceReferenceBody = {
 *   prompt: "p", image_urls: ["u"], duration: "5", resolution: "720p", aspect_ratio: "9:16", generate_audio: false
 * };
 * ```
 */
export type SeedanceReferenceBody = {
  prompt: string;
  image_urls: string[];
  audio_urls?: string[];
  duration: string;
  resolution: string;
  aspect_ratio: string;
  generate_audio: boolean;
};

/**
 * Request body of `minimax/h3/image-to-video` (native audio is always on: no audio flag).
 *
 * @example
 * ```ts
 * const body: MinimaxImageBody = { prompt: "p", image_url: "u", duration: 5, resolution: "768P" };
 * ```
 */
export type MinimaxImageBody = {
  prompt: string;
  image_url: string;
  duration: number;
  resolution: string;
};

/**
 * Request body of `minimax/h3-max/reference-to-video`: no first-frame field, so the
 * first frame leads `reference_image_urls`; native audio is always on.
 *
 * @example
 * ```ts
 * const body: MinimaxMaxReferenceBody = {
 *   prompt: "p", prompt_expansion_mode: "balanced", reference_image_urls: ["u"], duration: 5, resolution: "768P", aspect_ratio: "9:16"
 * };
 * ```
 */
export type MinimaxMaxReferenceBody = {
  prompt: string;
  prompt_expansion_mode: string;
  reference_image_urls: string[];
  reference_audio_urls?: string[];
  duration: number;
  resolution: string;
  aspect_ratio: string;
};

/**
 * Request body of `fal-ai/kling-video/v3/pro/image-to-video`.
 *
 * @example
 * ```ts
 * const body: KlingImageBody = { prompt: "p", start_image_url: "u", duration: "5", generate_audio: false };
 * ```
 */
export type KlingImageBody = {
  prompt: string;
  start_image_url: string;
  duration: string;
  generate_audio: boolean;
  negative_prompt?: string;
};

/**
 * Request body of `fal-ai/kling-video/o3/pro/reference-to-video`.
 *
 * @example
 * ```ts
 * const body: KlingReferenceBody = {
 *   prompt: "p", start_image_url: "u", image_urls: [], duration: "5", aspect_ratio: "9:16", generate_audio: false
 * };
 * ```
 */
export type KlingReferenceBody = {
  prompt: string;
  start_image_url: string;
  image_urls: string[];
  duration: string;
  aspect_ratio: string;
  generate_audio: boolean;
};

/**
 * Request body of `bytedance/seedance-2.0/image-to-video` and its Mini variant:
 * like Seedance 2.5 plus `aspect_ratio`.
 *
 * @example
 * ```ts
 * const body: Seedance20ImageBody = {
 *   prompt: "p", image_url: "u", duration: "5", resolution: "720p", aspect_ratio: "9:16", generate_audio: false
 * };
 * ```
 */
export type Seedance20ImageBody = {
  prompt: string;
  image_url: string;
  duration: string;
  resolution: string;
  aspect_ratio: string;
  generate_audio: boolean;
};

/**
 * Request body of `alibaba/wan-3.0/reference-to-video`: no first-frame field,
 * so the first frame leads `reference_image_urls`.
 *
 * @example
 * ```ts
 * const body: WanReferenceBody = {
 *   prompt: "p", reference_image_urls: ["u"], duration: 5, resolution: "720p", aspect_ratio: "9:16", audio: false
 * };
 * ```
 */
export type WanReferenceBody = {
  prompt: string;
  reference_image_urls: string[];
  reference_audio_urls?: string[];
  duration: number;
  resolution: string;
  aspect_ratio: string;
  audio: boolean;
};

/**
 * Request body of `fal-ai/veo3.1/fast/image-to-video`: duration in the form "8s".
 *
 * @example
 * ```ts
 * const body: VeoImageBody = {
 *   prompt: "p", image_url: "u", duration: "8s", resolution: "720p", aspect_ratio: "9:16", generate_audio: false
 * };
 * ```
 */
export type VeoImageBody = {
  prompt: string;
  image_url: string;
  duration: `${number}s`;
  resolution: string;
  aspect_ratio: string;
  generate_audio: boolean;
  negative_prompt?: string;
};

/**
 * Request body of `fal-ai/vidu/q3/image-to-video`: no aspect field, the clip
 * takes the first frame's aspect.
 *
 * @example
 * ```ts
 * const body: ViduImageBody = { prompt: "p", image_url: "u", duration: 5, resolution: "720p", audio: false };
 * ```
 */
export type ViduImageBody = {
  prompt: string;
  image_url: string;
  duration: number;
  resolution: string;
  audio: boolean;
};

/**
 * Request body of `fal-ai/vidu/q3/reference-to-video/mix`: the first frame
 * leads `reference_image_urls`.
 *
 * @example
 * ```ts
 * const body: ViduReferenceBody = {
 *   prompt: "p", reference_image_urls: ["u"], duration: 5, resolution: "720p", aspect_ratio: "9:16", audio: false
 * };
 * ```
 */
export type ViduReferenceBody = {
  prompt: string;
  reference_image_urls: string[];
  duration: number;
  resolution: string;
  aspect_ratio: string;
  audio: boolean;
};

/**
 * Any model's typed request body, before `request.params` is merged in.
 *
 * @example
 * ```ts
 * const body: FalBody = minimaxImageBody(input);
 * ```
 */
export type FalBody =
  | SeedanceImageBody
  | SeedanceReferenceBody
  | MinimaxImageBody
  | MinimaxMaxReferenceBody
  | KlingImageBody
  | KlingReferenceBody
  | Seedance20ImageBody
  | WanReferenceBody
  | VeoImageBody
  | ViduImageBody
  | ViduReferenceBody;

/**
 * One catalog row: fal endpoint, default resolution, audio capability,
 * reference-image and reference-audio limits (0 = none taken) and body builder.
 *
 * @example
 * ```ts
 * const row: FalModel = { endpoint: "minimax/h3/image-to-video", resolution: "768P", audio: true, maxRefs: 0, maxAudioRefs: 0, body: minimaxImageBody };
 * ```
 */
export type FalModel = {
  /** fal endpoint id, appended to `config.queueUrl`. */
  endpoint: string;
  /** Default resolution; absent when the model takes none. */
  resolution?: string;
  /** Whether the model can generate native audio. */
  audio: boolean;
  /** How many reference images the model accepts besides the first frame. */
  maxRefs: number;
  /** How many reference audio files (refs with an `audio/*` MIME type) the model accepts. */
  maxAudioRefs: number;
  /** Builds the typed request body. */
  body: (input: BodyInput) => FalBody;
};

/**
 * A catalog row together with the alias it was found under.
 *
 * @example
 * ```ts
 * const model: ResolvedFalModel = resolveFalModel("minimax-h3");
 * ```
 */
export type ResolvedFalModel = FalModel & { alias: FalAlias };

/**
 * URLs (or data URIs) of the uploaded input files.
 *
 * @example
 * ```ts
 * const urls: UploadedUrls = { image: "https://cdn/a.png", refs: [], audioRefs: [] };
 * ```
 */
export type UploadedUrls = {
  /** First frame. */
  image: string;
  /** Reference images, already checked against the model's limit. */
  refs: string[];
  /** Reference audio files, already checked against the model's limit. */
  audioRefs: string[];
};

/** Seedance default resolution. */
const SEEDANCE_RESOLUTION = "720p";

/** MiniMax H3 default resolution (fal's own default is the pricier 2K). */
const MINIMAX_RESOLUTION = "768P";

/** MiniMax H3 Max prompt rewriting mode: required by the schema; fal's documented default. */
const MINIMAX_PROMPT_EXPANSION = "balanced";

/** Wan 3.0 default resolution (fal's own default is the pricier 1080p). */
const WAN_RESOLUTION = "720p";

/** Veo 3.1 Fast default resolution. */
const VEO_RESOLUTION = "720p";

/** Vidu Q3 default resolution. */
const VIDU_RESOLUTION = "720p";

/** Aspect ratio used when the request names none. */
const DEFAULT_ASPECT = "9:16";

/** Clip length used when the request names none, seconds. */
const DEFAULT_SECONDS = 5;

/**
 * Seedance 2.5 image-to-video body.
 *
 * @param input - Resolved body input.
 * @returns The request body.
 * @example
 * ```ts
 * seedanceImageBody(input); // => { prompt, image_url, duration: "5", resolution: "720p", generate_audio }
 * ```
 */
function seedanceImageBody(input: BodyInput): SeedanceImageBody {
  return {
    prompt: input.prompt,
    image_url: input.imageUrl,
    duration: String(input.seconds),
    resolution: input.resolution ?? SEEDANCE_RESOLUTION,
    generate_audio: input.audio
  };
}

/**
 * Seedance reference-to-video body (2.5, 2.0 and 2.0 Mini): the first frame
 * leads `image_urls`; `audio_urls` only when there are audio refs.
 *
 * @param input - Resolved body input.
 * @returns The request body.
 * @example
 * ```ts
 * seedanceReferenceBody(input); // => { prompt, image_urls: [image, ...refs], ... }
 * ```
 */
function seedanceReferenceBody(input: BodyInput): SeedanceReferenceBody {
  const body: SeedanceReferenceBody = {
    prompt: input.prompt,
    image_urls: [input.imageUrl, ...input.refUrls],
    duration: String(input.seconds),
    resolution: input.resolution ?? SEEDANCE_RESOLUTION,
    aspect_ratio: input.aspect,
    generate_audio: input.audio
  };
  if (input.audioRefUrls.length > 0) body.audio_urls = input.audioRefUrls;
  return body;
}

/**
 * MiniMax H3 image-to-video body: integer duration, no audio flag.
 *
 * @param input - Resolved body input.
 * @returns The request body.
 * @example
 * ```ts
 * minimaxImageBody(input); // => { prompt, image_url, duration: 5, resolution: "768P" }
 * ```
 */
function minimaxImageBody(input: BodyInput): MinimaxImageBody {
  return {
    prompt: input.prompt,
    image_url: input.imageUrl,
    duration: input.seconds,
    resolution: input.resolution ?? MINIMAX_RESOLUTION
  };
}

/**
 * MiniMax H3 Max reference-to-video body: the first frame is Image 1 of
 * `reference_image_urls`; `reference_audio_urls` only when there are audio refs.
 *
 * @param input - Resolved body input.
 * @returns The request body.
 * @example
 * ```ts
 * minimaxMaxReferenceBody(input); // => { prompt, reference_image_urls: [image, ...refs], duration: 5, resolution: "768P", ... }
 * ```
 */
function minimaxMaxReferenceBody(input: BodyInput): MinimaxMaxReferenceBody {
  const body: MinimaxMaxReferenceBody = {
    prompt: input.prompt,
    prompt_expansion_mode: MINIMAX_PROMPT_EXPANSION,
    reference_image_urls: [input.imageUrl, ...input.refUrls],
    duration: input.seconds,
    resolution: input.resolution ?? MINIMAX_RESOLUTION,
    aspect_ratio: input.aspect
  };
  if (input.audioRefUrls.length > 0) body.reference_audio_urls = input.audioRefUrls;
  return body;
}

/**
 * Kling v3 pro image-to-video body: `negative_prompt` only when given.
 *
 * @param input - Resolved body input.
 * @returns The request body.
 * @example
 * ```ts
 * klingImageBody(input); // => { prompt, start_image_url, duration: "5", generate_audio }
 * ```
 */
function klingImageBody(input: BodyInput): KlingImageBody {
  const body: KlingImageBody = {
    prompt: input.prompt,
    start_image_url: input.imageUrl,
    duration: String(input.seconds),
    generate_audio: input.audio
  };
  if (input.negative !== undefined) body.negative_prompt = input.negative;
  return body;
}

/**
 * Kling O3 pro reference-to-video body: refs go to `image_urls`.
 *
 * @param input - Resolved body input.
 * @returns The request body.
 * @example
 * ```ts
 * klingReferenceBody(input); // => { prompt, start_image_url, image_urls: refs, ... }
 * ```
 */
function klingReferenceBody(input: BodyInput): KlingReferenceBody {
  return {
    prompt: input.prompt,
    start_image_url: input.imageUrl,
    image_urls: input.refUrls,
    duration: String(input.seconds),
    aspect_ratio: input.aspect,
    generate_audio: input.audio
  };
}

/**
 * Seedance 2.0 (and 2.0 Mini) image-to-video body: string duration, `aspect_ratio` sent.
 *
 * @param input - Resolved body input.
 * @returns The request body.
 * @example
 * ```ts
 * seedance20ImageBody(input); // => { prompt, image_url, duration: "5", resolution: "720p", aspect_ratio: "9:16", generate_audio }
 * ```
 */
function seedance20ImageBody(input: BodyInput): Seedance20ImageBody {
  return {
    prompt: input.prompt,
    image_url: input.imageUrl,
    duration: String(input.seconds),
    resolution: input.resolution ?? SEEDANCE_RESOLUTION,
    aspect_ratio: input.aspect,
    generate_audio: input.audio
  };
}

/**
 * Wan 3.0 reference-to-video body: the first frame leads `reference_image_urls`,
 * integer duration, `reference_audio_urls` only when there are audio refs.
 *
 * @param input - Resolved body input.
 * @returns The request body.
 * @example
 * ```ts
 * wanReferenceBody(input); // => { prompt, reference_image_urls: [image, ...refs], duration: 5, resolution: "720p", ... }
 * ```
 */
function wanReferenceBody(input: BodyInput): WanReferenceBody {
  const body: WanReferenceBody = {
    prompt: input.prompt,
    reference_image_urls: [input.imageUrl, ...input.refUrls],
    duration: input.seconds,
    resolution: input.resolution ?? WAN_RESOLUTION,
    aspect_ratio: input.aspect,
    audio: input.audio
  };
  if (input.audioRefUrls.length > 0) body.reference_audio_urls = input.audioRefUrls;
  return body;
}

/**
 * Veo 3.1 Fast image-to-video body: duration as "4s" | "6s" | "8s",
 * `negative_prompt` only when given.
 *
 * @param input - Resolved body input.
 * @returns The request body.
 * @example
 * ```ts
 * veoImageBody(input); // => { prompt, image_url, duration: "8s", resolution: "720p", aspect_ratio: "9:16", generate_audio }
 * ```
 */
function veoImageBody(input: BodyInput): VeoImageBody {
  const body: VeoImageBody = {
    prompt: input.prompt,
    image_url: input.imageUrl,
    duration: `${input.seconds}s`,
    resolution: input.resolution ?? VEO_RESOLUTION,
    aspect_ratio: input.aspect,
    generate_audio: input.audio
  };
  if (input.negative !== undefined) body.negative_prompt = input.negative;
  return body;
}

/**
 * Vidu Q3 image-to-video body: integer duration, the aspect follows the image.
 *
 * @param input - Resolved body input.
 * @returns The request body.
 * @example
 * ```ts
 * viduImageBody(input); // => { prompt, image_url, duration: 5, resolution: "720p", audio }
 * ```
 */
function viduImageBody(input: BodyInput): ViduImageBody {
  return {
    prompt: input.prompt,
    image_url: input.imageUrl,
    duration: input.seconds,
    resolution: input.resolution ?? VIDU_RESOLUTION,
    audio: input.audio
  };
}

/**
 * Vidu Q3 mix reference-to-video body: the first frame leads `reference_image_urls`.
 *
 * @param input - Resolved body input.
 * @returns The request body.
 * @example
 * ```ts
 * viduReferenceBody(input); // => { prompt, reference_image_urls: [image, ...refs], duration: 5, resolution: "720p", ... }
 * ```
 */
function viduReferenceBody(input: BodyInput): ViduReferenceBody {
  return {
    prompt: input.prompt,
    reference_image_urls: [input.imageUrl, ...input.refUrls],
    duration: input.seconds,
    resolution: input.resolution ?? VIDU_RESOLUTION,
    aspect_ratio: input.aspect,
    audio: input.audio
  };
}

/**
 * The model catalog, in the order `info().models` and error messages list it.
 *
 * @example
 * ```ts
 * falModels["minimax-h3"].endpoint; // => "minimax/h3/image-to-video"
 * ```
 */
export const falModels: Readonly<Record<FalAlias, FalModel>> = {
  "seedance-2.5": {
    endpoint: "bytedance/seedance-2.5/image-to-video",
    resolution: SEEDANCE_RESOLUTION,
    audio: true,
    maxRefs: 0,
    maxAudioRefs: 0,
    body: seedanceImageBody
  },
  "seedance-2.5-ref": {
    endpoint: "bytedance/seedance-2.5/reference-to-video",
    resolution: SEEDANCE_RESOLUTION,
    audio: true,
    maxRefs: 29,
    maxAudioRefs: 10,
    body: seedanceReferenceBody
  },
  "minimax-h3": {
    endpoint: "minimax/h3/image-to-video",
    resolution: MINIMAX_RESOLUTION,
    audio: true,
    maxRefs: 0,
    maxAudioRefs: 0,
    body: minimaxImageBody
  },
  "minimax-h3-max-ref": {
    endpoint: "minimax/h3-max/reference-to-video",
    resolution: MINIMAX_RESOLUTION,
    audio: true,
    maxRefs: 8,
    maxAudioRefs: 3,
    body: minimaxMaxReferenceBody
  },
  "kling-3-pro": {
    endpoint: "fal-ai/kling-video/v3/pro/image-to-video",
    audio: true,
    maxRefs: 0,
    maxAudioRefs: 0,
    body: klingImageBody
  },
  "kling-o3-ref": {
    endpoint: "fal-ai/kling-video/o3/pro/reference-to-video",
    audio: true,
    maxRefs: 4,
    maxAudioRefs: 0,
    body: klingReferenceBody
  },
  "seedance-2.0-mini": {
    endpoint: "bytedance/seedance-2.0/mini/image-to-video",
    resolution: SEEDANCE_RESOLUTION,
    audio: true,
    maxRefs: 0,
    maxAudioRefs: 0,
    body: seedance20ImageBody
  },
  "seedance-2.0-mini-ref": {
    endpoint: "bytedance/seedance-2.0/mini/reference-to-video",
    resolution: SEEDANCE_RESOLUTION,
    audio: true,
    maxRefs: 8,
    maxAudioRefs: 3,
    body: seedanceReferenceBody
  },
  "seedance-2.0-ref": {
    endpoint: "bytedance/seedance-2.0/reference-to-video",
    resolution: SEEDANCE_RESOLUTION,
    audio: true,
    maxRefs: 8,
    maxAudioRefs: 3,
    body: seedanceReferenceBody
  },
  "wan-3.0-ref": {
    endpoint: "alibaba/wan-3.0/reference-to-video",
    resolution: WAN_RESOLUTION,
    audio: true,
    maxRefs: 9,
    maxAudioRefs: 5,
    body: wanReferenceBody
  },
  "veo-3.1-fast": {
    endpoint: "fal-ai/veo3.1/fast/image-to-video",
    resolution: VEO_RESOLUTION,
    audio: true,
    maxRefs: 0,
    maxAudioRefs: 0,
    body: veoImageBody
  },
  "vidu-q3": {
    endpoint: "fal-ai/vidu/q3/image-to-video",
    resolution: VIDU_RESOLUTION,
    audio: true,
    maxRefs: 0,
    maxAudioRefs: 0,
    body: viduImageBody
  },
  "vidu-q3-ref": {
    endpoint: "fal-ai/vidu/q3/reference-to-video/mix",
    resolution: VIDU_RESOLUTION,
    audio: true,
    maxRefs: 3,
    maxAudioRefs: 0,
    body: viduReferenceBody
  }
};

/**
 * The accepted model aliases, in catalog order.
 *
 * @returns Alias list.
 * @example
 * ```ts
 * falAliases(); // => ["seedance-2.5", "seedance-2.5-ref", "minimax-h3", "minimax-h3-max-ref", "kling-3-pro", "kling-o3-ref", "seedance-2.0-mini", "seedance-2.0-mini-ref", "seedance-2.0-ref", "wan-3.0-ref", "veo-3.1-fast", "vidu-q3", "vidu-q3-ref"]
 * ```
 */
export function falAliases(): string[] {
  return Object.keys(falModels);
}

/**
 * Whether `model` is one of the catalog's own aliases (inherited keys excluded).
 *
 * @param model - The requested model string.
 * @returns True for a known alias.
 * @example
 * ```ts
 * isFalAlias("minimax-h3"); // => true
 * ```
 */
function isFalAlias(model: string): model is FalAlias {
  return Object.hasOwn(falModels, model);
}

/**
 * Looks up the catalog row for `model`.
 *
 * @param model - The requested model string (`request.model`).
 * @returns The catalog row and its alias.
 * @throws {Error} The pinned two-line "unknown model" error listing the aliases.
 * @example
 * ```ts
 * resolveFalModel("minimax-h3").endpoint; // => "minimax/h3/image-to-video"
 * ```
 */
export function resolveFalModel(model: string): ResolvedFalModel {
  if (!isFalAlias(model)) {
    throw new Error(
      `[ai] Unknown fal video model "${model}".\n  Use one of: ${falAliases().join(", ")}.`
    );
  }
  return { ...falModels[model], alias: model };
}

/**
 * The clip length a request asks for, defaulting to 5 seconds.
 *
 * @param request - The video request.
 * @returns Seconds.
 * @example
 * ```ts
 * requestSeconds({ model: "minimax-h3", prompt: "p" }); // => 5
 * ```
 */
export function requestSeconds(request: VideoRequest): number {
  return request.seconds ?? DEFAULT_SECONDS;
}

/**
 * The effective resolution: the request's own, else the model default
 * (undefined for a model that takes none).
 *
 * @param model - The resolved catalog row.
 * @param request - The video request.
 * @returns The resolution, or undefined.
 * @example
 * ```ts
 * modelResolution(resolveFalModel("minimax-h3"), request); // => "768P"
 * ```
 */
export function modelResolution(model: FalModel, request: VideoRequest): string | undefined {
  return request.resolution ?? model.resolution;
}

/**
 * Whether audio is on: requested with `audio: true` and the model can make it.
 *
 * @param model - The resolved catalog row.
 * @param request - The video request.
 * @returns True when the clip gets native audio.
 * @example
 * ```ts
 * modelAudio(resolveFalModel("kling-o3-ref"), { ...request, audio: true }); // => true
 * ```
 */
export function modelAudio(model: FalModel, request: VideoRequest): boolean {
  return request.audio === true && model.audio;
}

/**
 * Builds the JSON body POSTed to the model's endpoint: the typed model body
 * with `request.params` merged last. The result is the wire payload, open by
 * contract because `params` is arbitrary pass-through.
 *
 * @param model - The resolved catalog row.
 * @param request - The video request.
 * @param urls - Uploaded URLs (or data URIs) of the first frame, image refs and audio refs.
 * @returns The request body.
 * @example
 * ```ts
 * buildFalBody(resolveFalModel("minimax-h3"), request, { image: "https://cdn/a.png", refs: [], audioRefs: [] });
 * ```
 */
export function buildFalBody(
  model: FalModel,
  request: VideoRequest,
  urls: UploadedUrls
): Record<string, unknown> {
  const body = model.body({
    prompt: request.prompt,
    imageUrl: urls.image,
    refUrls: urls.refs,
    audioRefUrls: urls.audioRefs,
    seconds: requestSeconds(request),
    resolution: modelResolution(model, request),
    aspect: request.aspect ?? DEFAULT_ASPECT,
    audio: modelAudio(model, request),
    negative: request.negative
  });
  return { ...body, ...request.params };
}
