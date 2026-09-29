/**
 * @file apimodels video model catalog — alias table, request validation and
 * body builder. Two frame aliases (`image` → `first_frame_url`, `endImage` →
 * `last_frame_url`, no refs) and two reference aliases (`image` leads
 * `reference_image_urls`, refs told apart by MIME, no end frame), for
 * Seedance 2.5 and Seedance 2.0 official. Every refusal is a terminal 400
 * raised before any upload or charge.
 */
import type { EstimateInput, EstimateRequest, VideoFile, VideoRequest } from "../../video/contract";
import { refusal } from "../http";
import type { TerminalProviderError } from "../types";

/**
 * A model alias this plugin serves. The names mirror fal's Seedance aliases,
 * so a build item switches `provider` only.
 *
 * @example
 * ```ts
 * const alias: ApimodelsAlias = "seedance-2.5-ref";
 * ```
 */
export type ApimodelsAlias =
  | "seedance-2.5"
  | "seedance-2.5-ref"
  | "seedance-2.0"
  | "seedance-2.0-ref";

/**
 * How an alias takes its inputs: first and last frame, or references.
 *
 * @example
 * ```ts
 * const mode: ModelMode = "frames";
 * ```
 */
export type ModelMode = "frames" | "references";

/**
 * One catalog row: the upstream model id, the input mode, the resolutions and
 * clip lengths it takes, and its reference limits.
 *
 * @example
 * ```ts
 * const row: ApimodelsModel = {
 *   apiModel: "seedance-2.0-official", mode: "references", resolutions: ["480p", "720p", "1080p"],
 *   defaultResolution: "720p", minSeconds: 4, maxSeconds: 15, maxImages: 9, maxAudioRefs: 10, maxVideoRefs: 10
 * };
 * ```
 */
export type ApimodelsModel = {
  /** Upstream `model` field. */
  apiModel: string;
  /** Frames (first/last frame) or references. */
  mode: ModelMode;
  /** Accepted resolutions. */
  resolutions: readonly string[];
  /** Resolution used when the request names none. */
  defaultResolution: string;
  /** Shortest clip, seconds. */
  minSeconds: number;
  /** Longest clip, seconds. */
  maxSeconds: number;
  /** Reference images, `input.image` included (1 on a frames alias). */
  maxImages: number;
  /** Reference audio files (0 on a frames alias). */
  maxAudioRefs: number;
  /** Reference videos (0 on a frames alias). */
  maxVideoRefs: number;
};

/**
 * A catalog row together with the alias it was found under.
 *
 * @example
 * ```ts
 * const model: ResolvedModel = resolveModel("seedance-2.5");
 * ```
 */
export type ResolvedModel = ApimodelsModel & { alias: ApimodelsAlias };

/**
 * The URL (https upload or `asset://` id) of each input, refs split by MIME.
 *
 * @example
 * ```ts
 * const urls: InputUrls = { image: "asset://asset-1", imageRefs: [], audioRefs: [], videoRefs: [] };
 * ```
 */
export type InputUrls = {
  /** First frame, or `@image1` on a reference alias. */
  image: string;
  /** End frame, when the request has one. */
  endImage?: string | undefined;
  /** Image refs, in request order. */
  imageRefs: string[];
  /** Audio refs, in request order. */
  audioRefs: string[];
  /** Video refs, in request order. */
  videoRefs: string[];
};

/**
 * The typed fields of the JSON body POSTed to `/video/generations`, before
 * `request.params` is merged in. A frames alias sends `first_frame_url` (and
 * `last_frame_url`); a reference alias sends `aspect_ratio` and the
 * `reference_*_urls` lists.
 *
 * @example
 * ```ts
 * const body: SeedanceBody = {
 *   model: "seedance-2.5", prompt: "push-in", resolution: "720p", duration: 5, generate_audio: false, first_frame_url: "asset://a1"
 * };
 * ```
 */
export type SeedanceBody = {
  /** Upstream model id, e.g. "seedance-2.0-official". */
  model: string;
  /** Motion and scene prompt. */
  prompt: string;
  /** Output resolution, e.g. "720p". */
  resolution: string;
  /** Clip length, seconds. */
  duration: number;
  /** Whether upstream generates native audio. */
  generate_audio: boolean;
  /** Aspect ratio; reference aliases only (a first frame makes upstream adaptive). */
  aspect_ratio?: string;
  /** First frame (https or `asset://`); frames aliases only. */
  first_frame_url?: string;
  /** Last frame; frames aliases with an end frame only. */
  last_frame_url?: string;
  /** `input.image` first (`@image1`), then the image refs; reference aliases only. */
  reference_image_urls?: string[];
  /** Audio refs, only when the request has some. */
  reference_audio_urls?: string[];
  /** Video refs, only when the request has some. */
  reference_video_urls?: string[];
};

/**
 * The body as POSTed: a closed {@link SeedanceBody}, then `request.params`
 * (without `assets`) merged last. Only the merged params are open, and only
 * for reading: they pass through by contract. Build the fixed fields as a
 * `SeedanceBody` const and spread the params over it, never as a `SubmitBody`
 * literal: its open part would let a misspelled fixed field through.
 *
 * @example
 * ```ts
 * const fixed: SeedanceBody = { model: "seedance-2.5", prompt: "push-in", resolution: "720p", duration: 5, generate_audio: false };
 * const params: Record<string, unknown> = { output_format: "mov" }; // request.params without assets
 * const body: SubmitBody = { ...fixed, ...params };
 * ```
 */
export type SubmitBody = SeedanceBody & Readonly<Record<string, unknown>>;

/** The input fields of a frames alias. */
type FrameFields = Pick<SeedanceBody, "first_frame_url" | "last_frame_url">;

/** The input fields of a reference alias. */
type ReferenceFields = Pick<
  SeedanceBody,
  "aspect_ratio" | "reference_image_urls" | "reference_audio_urls" | "reference_video_urls"
>;

/**
 * Kind of a ref: by MIME once resolved, unknown before.
 *
 * @example
 * ```ts
 * const kind: ReferenceKind = "audio";
 * ```
 */
export type ReferenceKind = "image" | "audio" | "video" | "unknown";

/** Seedance resolutions without 1080p (2.5). */
const SD_HD = ["480p", "720p"] as const;

/** Seedance resolutions with 1080p (2.0 official). */
const SD_HD_FHD = ["480p", "720p", "1080p"] as const;

/** Resolution used when the request names none. */
const DEFAULT_RESOLUTION = "720p";

/** Clip length used when the request names none, seconds. */
const DEFAULT_SECONDS = 5;

/** Shortest clip every alias takes, seconds. */
const MIN_SECONDS = 4;

/** Native audio when the request names none: off, as the video contract says. */
const DEFAULT_AUDIO = false;

/** Aspect ratio used when the request names none (ignored with a first frame). */
const DEFAULT_ASPECT = "9:16";

/** Reserved `params` key naming the inputs to register; never sent upstream. */
const ASSETS_PARAM = "assets";

/** Reference audio and reference video limit of the Seedance reference aliases. */
const MEDIA_REFS = 10;

/**
 * A frames alias: `image` → `first_frame_url`, `endImage` → `last_frame_url`.
 *
 * @param apiModel - Upstream model id.
 * @param resolutions - Accepted resolutions.
 * @param maxSeconds - Longest clip, seconds.
 * @returns The catalog row.
 * @example
 * ```ts
 * framesModel("seedance-2.5", ["480p", "720p"], 30).mode; // => "frames"
 * ```
 */
function framesModel(
  apiModel: string,
  resolutions: readonly string[],
  maxSeconds: number
): ApimodelsModel {
  return {
    apiModel,
    mode: "frames",
    resolutions,
    defaultResolution: DEFAULT_RESOLUTION,
    minSeconds: MIN_SECONDS,
    maxSeconds,
    maxImages: 1,
    maxAudioRefs: 0,
    maxVideoRefs: 0
  };
}

/**
 * A reference alias: `image` leads `reference_image_urls`, audio and video
 * refs go to their own lists.
 *
 * @param apiModel - Upstream model id.
 * @param resolutions - Accepted resolutions.
 * @param maxSeconds - Longest clip, seconds.
 * @param maxImages - Reference images, `input.image` included.
 * @returns The catalog row.
 * @example
 * ```ts
 * referencesModel("seedance-2.5", ["480p", "720p"], 30, 30).maxImages; // => 30
 * ```
 */
function referencesModel(
  apiModel: string,
  resolutions: readonly string[],
  maxSeconds: number,
  maxImages: number
): ApimodelsModel {
  return {
    ...framesModel(apiModel, resolutions, maxSeconds),
    mode: "references",
    maxImages,
    maxAudioRefs: MEDIA_REFS,
    maxVideoRefs: MEDIA_REFS
  };
}

/** The catalog, in the order `info().models` and error messages list it. */
const models: Readonly<Record<ApimodelsAlias, ApimodelsModel>> = {
  "seedance-2.5": framesModel("seedance-2.5", SD_HD, 30),
  "seedance-2.5-ref": referencesModel("seedance-2.5", SD_HD, 30, 30),
  "seedance-2.0": framesModel("seedance-2.0-official", SD_HD_FHD, 15),
  "seedance-2.0-ref": referencesModel("seedance-2.0-official", SD_HD_FHD, 15, 9)
};

/**
 * The served model aliases, in catalog order.
 *
 * @returns Alias list.
 * @example
 * ```ts
 * apimodelsAliases(); // => ["seedance-2.5", "seedance-2.5-ref", "seedance-2.0", "seedance-2.0-ref"]
 * ```
 */
export function apimodelsAliases(): string[] {
  return Object.keys(models);
}

/**
 * The aliases of one input mode, in catalog order.
 *
 * @param mode - Frames or references.
 * @returns Alias list.
 * @example
 * ```ts
 * aliasesOf("frames"); // => ["seedance-2.5", "seedance-2.0"]
 * ```
 */
function aliasesOf(mode: ModelMode): string[] {
  return Object.entries(models)
    .filter(([, model]) => model.mode === mode)
    .map(([alias]) => alias);
}

/**
 * Whether `model` is one of the catalog's own aliases (inherited keys excluded).
 *
 * @param model - The requested model string.
 * @returns True for a served alias.
 * @example
 * ```ts
 * isAlias("seedance-2.5"); // => true
 * ```
 */
function isAlias(model: string): model is ApimodelsAlias {
  return Object.hasOwn(models, model);
}

/**
 * Looks up the catalog row for `model`.
 *
 * @param model - The requested model string (`request.model`).
 * @returns The catalog row and its alias.
 * @throws {TerminalProviderError} A 400 listing the served aliases.
 * @example
 * ```ts
 * resolveModel("seedance-2.0").apiModel; // => "seedance-2.0-official"
 * ```
 */
export function resolveModel(model: string): ResolvedModel {
  if (!isAlias(model)) {
    throw refusal(
      `[ai] Unknown apimodels video model "${model}".\n  Use one of: ${apimodelsAliases().join(", ")}.`
    );
  }
  return { ...models[model], alias: model };
}

/**
 * The clip length a request asks for, defaulting to 5 seconds.
 *
 * @param request - The video request.
 * @returns Seconds.
 * @example
 * ```ts
 * requestSeconds({ model: "seedance-2.5", prompt: "p" }); // => 5
 * ```
 */
export function requestSeconds(request: EstimateRequest): number {
  return request.seconds ?? DEFAULT_SECONDS;
}

/**
 * The effective resolution: the request's own, else the model default.
 *
 * @param model - The catalog row.
 * @param request - The video request.
 * @returns The resolution.
 * @example
 * ```ts
 * requestResolution(resolveModel("seedance-2.5"), { model: "seedance-2.5", prompt: "p" }); // => "720p"
 * ```
 */
export function requestResolution(model: ApimodelsModel, request: EstimateRequest): string {
  return request.resolution ?? model.defaultResolution;
}

/**
 * Whether a request input is a resolved file rather than a `$ref` / `$file`.
 *
 * @param input - A request image, end frame or ref.
 * @returns True for a resolved `VideoFile`.
 * @example
 * ```ts
 * isResolvedFile({ $file: "a.png" }); // => false
 * ```
 */
export function isResolvedFile(input: EstimateInput): input is VideoFile {
  return "path" in input && "mimeType" in input && "hash" in input;
}

/**
 * The kind of a ref: image, audio or video by MIME once resolved; unknown
 * while it is still a `$ref` / `$file`.
 *
 * @param input - A request ref.
 * @returns The ref kind.
 * @example
 * ```ts
 * referenceKindOf({ path: "v.mp3", mimeType: "audio/mpeg", hash: "h" }); // => "audio"
 * ```
 */
export function referenceKindOf(input: EstimateInput): ReferenceKind {
  if (!isResolvedFile(input)) return "unknown";
  if (input.mimeType.startsWith("audio/")) return "audio";
  if (input.mimeType.startsWith("video/")) return "video";
  return "image";
}

/**
 * Counts the refs of each kind.
 *
 * @param references - The request's refs.
 * @returns Count per kind.
 * @example
 * ```ts
 * countReferences([{ $ref: "a" }, { path: "b.png", mimeType: "image/png", hash: "h" }]); // => { image: 1, audio: 0, video: 0, unknown: 1 }
 * ```
 */
function countReferences(references: readonly EstimateInput[]): Record<ReferenceKind, number> {
  const counts: Record<ReferenceKind, number> = { image: 0, audio: 0, video: 0, unknown: 0 };
  for (const reference of references) counts[referenceKindOf(reference)] += 1;
  return counts;
}

/**
 * The two-line error for refs over a model's limit.
 *
 * @param alias - The model alias.
 * @param what - What is over the limit.
 * @param max - The limit.
 * @param given - How many the request has.
 * @returns A terminal 400.
 * @example
 * ```ts
 * tooMany("seedance-2.0-ref", "reference videos", 10, 11).message; // => '[ai] apimodels model "seedance-2.0-ref" takes at most 10 reference videos, got 11.\n  Remove refs from input.refs, or use a model that takes more.'
 * ```
 */
function tooMany(alias: string, what: string, max: number, given: number): TerminalProviderError {
  return refusal(
    `[ai] apimodels model "${alias}" takes at most ${max} ${what}, got ${given}.\n  Remove refs from input.refs, or use a model that takes more.`
  );
}

/**
 * Checks the refs of a reference alias against its limits. Resolved refs
 * count by MIME; unresolved ones (estimate time) count only against the
 * total, so a valid build is never refused before its refs are known.
 *
 * @param model - The resolved catalog row.
 * @param references - The request's refs.
 * @throws {TerminalProviderError} A 400 naming the limit that is exceeded.
 * @example
 * ```ts
 * checkReferenceLimits(resolveModel("seedance-2.0-ref"), Array.from({ length: 9 }, () => ({ path: "a.png", mimeType: "image/png", hash: "h" })));
 * // throws: '[ai] apimodels model "seedance-2.0-ref" takes at most 9 reference images (input.image included), got 10. ...'
 * ```
 */
function checkReferenceLimits(model: ResolvedModel, references: readonly EstimateInput[]): void {
  const counts = countReferences(references);
  const images = counts.image + 1;
  const total = references.length + 1;
  const maxTotal = model.maxImages + model.maxAudioRefs + model.maxVideoRefs;

  if (images > model.maxImages) {
    throw tooMany(model.alias, "reference images (input.image included)", model.maxImages, images);
  }
  if (counts.audio > model.maxAudioRefs) {
    throw tooMany(model.alias, "reference audio files", model.maxAudioRefs, counts.audio);
  }
  if (counts.video > model.maxVideoRefs) {
    throw tooMany(model.alias, "reference videos", model.maxVideoRefs, counts.video);
  }
  if (total > maxTotal) {
    throw tooMany(model.alias, "inputs in total (input.image included)", maxTotal, total);
  }
}

/**
 * Refuses the inputs a model does not take: no image, an end frame on a
 * reference alias, refs on a frames alias, or refs over the limits.
 *
 * @param model - The resolved catalog row.
 * @param request - The request, resolved or not.
 * @throws {TerminalProviderError} A 400 naming the field and the fix.
 * @example
 * ```ts
 * checkInputs(resolveModel("seedance-2.5"), { model: "seedance-2.5", prompt: "p" });
 * // throws: '[ai] apimodels model "seedance-2.5" needs an image.\n  Set input.image to a $ref or $file.'
 * ```
 */
function checkInputs(model: ResolvedModel, request: EstimateRequest): void {
  const references = request.refs ?? [];
  const hasRefusedEndFrame = request.endImage !== undefined && model.mode === "references";
  const hasRefusedReferences = references.length > 0 && model.mode === "frames";

  if (request.image === undefined) {
    throw refusal(
      `[ai] apimodels model "${model.alias}" needs an image.\n  Set input.image to a $ref or $file.`
    );
  }
  if (hasRefusedEndFrame) {
    throw refusal(
      `[ai] apimodels model "${model.alias}" takes no end frame.\n  Remove input.endImage, or use a model that takes one: ${aliasesOf("frames").join(", ")}.`
    );
  }
  if (hasRefusedReferences) {
    throw refusal(
      `[ai] apimodels model "${model.alias}" takes no refs.\n  Remove input.refs, or use a model that takes them: ${aliasesOf("references").join(", ")}.`
    );
  }
  if (model.mode === "references") checkReferenceLimits(model, references);
}

/**
 * Refuses a resolution outside the model's list, or a clip length that is
 * not a whole number inside its range.
 *
 * @param model - The resolved catalog row.
 * @param request - The request.
 * @throws {TerminalProviderError} A 400 naming the field and the allowed values.
 * @example
 * ```ts
 * checkShape(resolveModel("seedance-2.0"), { model: "seedance-2.0", prompt: "p", seconds: 16 });
 * // throws: '[ai] apimodels model "seedance-2.0" takes 4 to 15 seconds, got 16. ...'
 * ```
 */
function checkShape(model: ResolvedModel, request: EstimateRequest): void {
  const resolution = requestResolution(model, request);
  const seconds = requestSeconds(request);
  const isInRange =
    Number.isInteger(seconds) && seconds >= model.minSeconds && seconds <= model.maxSeconds;
  const range = `${model.minSeconds} to ${model.maxSeconds}`;

  if (!model.resolutions.includes(resolution)) {
    throw refusal(
      `[ai] apimodels model "${model.alias}" has no resolution "${resolution}".\n  Set input.resolution to one of: ${model.resolutions.join(", ")}.`
    );
  }
  if (!isInRange) {
    throw refusal(
      `[ai] apimodels model "${model.alias}" takes ${range} seconds, got ${seconds}.\n  Set input.seconds to a whole number from ${range}.`
    );
  }
}

/**
 * Validates a request against its model, at estimate and at submit: inputs
 * first, then resolution and clip length. Nothing is uploaded or paid before.
 *
 * @param model - The resolved catalog row.
 * @param request - The request, resolved or not.
 * @throws {TerminalProviderError} A 400 naming the field and the allowed values.
 * @example
 * ```ts
 * checkRequest(resolveModel("seedance-2.5-ref"), { model: "seedance-2.5-ref", prompt: "p", image: { $ref: "k" }, endImage: { $ref: "e" } });
 * // throws: '[ai] apimodels model "seedance-2.5-ref" takes no end frame. ...'
 * ```
 */
export function checkRequest(model: ResolvedModel, request: EstimateRequest): void {
  checkInputs(model, request);
  checkShape(model, request);
}

/**
 * `request.params` without the reserved `assets` key.
 *
 * @param params - The request's pass-through params.
 * @returns The params to merge into the body.
 * @example
 * ```ts
 * passThroughParameters({ assets: ["image"], output_format: "mov" }); // => { output_format: "mov" }
 * ```
 */
function passThroughParameters(
  params: Record<string, unknown> | undefined
): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...params };
  delete rest[ASSETS_PARAM];
  return rest;
}

/**
 * The input fields of a frames alias. No `aspect_ratio`: upstream forces
 * adaptive when `first_frame_url` is set.
 *
 * @param urls - Input URLs.
 * @returns The frame fields.
 * @example
 * ```ts
 * frameFields({ image: "u1", endImage: "u2", imageRefs: [], audioRefs: [], videoRefs: [] }); // => { first_frame_url: "u1", last_frame_url: "u2" }
 * ```
 */
function frameFields(urls: InputUrls): FrameFields {
  const fields: FrameFields = { first_frame_url: urls.image };
  if (urls.endImage !== undefined) fields.last_frame_url = urls.endImage;
  return fields;
}

/**
 * The input fields of a reference alias: the image leads
 * `reference_image_urls` (`@image1`); audio and video lists only when there
 * are such refs.
 *
 * @param urls - Input URLs.
 * @param aspect - The aspect ratio.
 * @returns The reference fields.
 * @example
 * ```ts
 * referenceFields({ image: "u1", imageRefs: ["u2"], audioRefs: [], videoRefs: [] }, "9:16"); // => { aspect_ratio: "9:16", reference_image_urls: ["u1", "u2"] }
 * ```
 */
function referenceFields(urls: InputUrls, aspect: string): ReferenceFields {
  const fields: ReferenceFields = {
    aspect_ratio: aspect,
    reference_image_urls: [urls.image, ...urls.imageRefs]
  };
  if (urls.audioRefs.length > 0) fields.reference_audio_urls = urls.audioRefs;
  if (urls.videoRefs.length > 0) fields.reference_video_urls = urls.videoRefs;
  return fields;
}

/**
 * Builds the JSON body POSTed to `/video/generations`: the model fields,
 * the input fields of its mode, then `request.params` (without `assets`)
 * merged last. `generate_audio` is false unless the request asks for audio.
 * `negative` is not supported upstream and never sent.
 *
 * @param model - The resolved catalog row.
 * @param request - The validated request.
 * @param urls - URLs (https or `asset://`) of the inputs.
 * @returns The request body: the closed fixed fields, then the params.
 * @example
 * ```ts
 * buildBody(resolveModel("seedance-2.0"), { model: "seedance-2.0", prompt: "push-in" }, { image: "asset://a1", imageRefs: [], audioRefs: [], videoRefs: [] });
 * // => { model: "seedance-2.0-official", prompt: "push-in", resolution: "720p", duration: 5, generate_audio: false, first_frame_url: "asset://a1" }
 * ```
 */
export function buildBody(
  model: ResolvedModel,
  request: VideoRequest,
  urls: InputUrls
): SubmitBody {
  // The model fields and the inputs of its mode.
  const inputs =
    model.mode === "frames"
      ? frameFields(urls)
      : referenceFields(urls, request.aspect ?? DEFAULT_ASPECT);
  const body: SeedanceBody = {
    model: model.apiModel,
    prompt: request.prompt,
    resolution: requestResolution(model, request),
    duration: requestSeconds(request),
    generate_audio: request.audio ?? DEFAULT_AUDIO,
    ...inputs
  };

  // request.params pass through last.
  return { ...body, ...passThroughParameters(request.params) };
}
