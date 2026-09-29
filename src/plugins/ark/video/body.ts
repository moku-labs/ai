/**
 * @file ark video body — maps a flat `VideoRequest` plus `params` to the Ark
 * task body (`POST {base}/contents/generations/tasks`). Three steps, so the
 * handler can check every asset between them and before any paid call:
 * `checkVideoRequest` refuses what the model cannot take (no I/O),
 * `readInputs` reads the local images as data URIs and the asset refs as
 * their records, and `buildArkBody` assembles the body (pure). The prompt is
 * never rewritten: it cites refs by position ("image 1").
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AssetRecord } from "../../asset/contract";
import { ASSET_MIME, parseAssetRecord } from "../../asset/contract";
import type { VideoFile, VideoRequest } from "../../video/contract";
import type { ArkVideoModel } from "../models";
import { checkClip } from "../models";
import type { ArkContext } from "../types";

/**
 * The `ratio` values Ark takes, from `request.aspect`.
 *
 * @example
 * ```ts
 * ARK_RATIOS.includes("adaptive"); // => true
 * ```
 */
export const ARK_RATIOS: readonly string[] = [
  "16:9",
  "9:16",
  "1:1",
  "4:3",
  "3:4",
  "21:9",
  "adaptive"
];

/**
 * The `params` keys ark takes: `refUrls` plus the allow-listed passthrough.
 *
 * @example
 * ```ts
 * ARK_PARAMS[0]; // => "refUrls"
 * ```
 */
export const ARK_PARAMS = [
  "refUrls",
  "watermark",
  "seed",
  "return_last_frame",
  "execution_expires_after",
  "priority"
] as const;

/**
 * A `params` key ark takes.
 *
 * @example
 * ```ts
 * const key: ArkParameterName = "watermark";
 * ```
 */
export type ArkParameterName = (typeof ARK_PARAMS)[number];

/**
 * A `params` key passed through to the body as given.
 *
 * @example
 * ```ts
 * const key: ArkPassthroughKey = "return_last_frame";
 * ```
 */
export type ArkPassthroughKey = Exclude<ArkParameterName, "refUrls">;

/**
 * The allow-listed passthrough params. Values come from the build file's
 * `params` (a JSON value of any kind) and go to ark as given: ark validates them.
 *
 * @example
 * ```ts
 * const params: ArkPassthrough = { watermark: true, return_last_frame: true };
 * ```
 */
export type ArkPassthrough = Partial<Record<ArkPassthroughKey, unknown>>;

/**
 * Role of an image in the content list.
 *
 * @example
 * ```ts
 * const role: ArkImageRole = "reference_image";
 * ```
 */
export type ArkImageRole = "first_frame" | "last_frame" | "reference_image";

/**
 * A reference video or audio by public URL, from `params.refUrls`.
 *
 * @example
 * ```ts
 * const item: ArkMediaItem = { type: "video_url", video_url: { url: "https://cdn.example/walk.mp4" }, role: "reference_video" };
 * ```
 */
export type ArkMediaItem =
  | { type: "video_url"; video_url: { url: string }; role: "reference_video" }
  | { type: "audio_url"; audio_url: { url: string }; role: "reference_audio" };

/**
 * One entry of the body's `content` list.
 *
 * @example
 * ```ts
 * const item: ArkContentItem = { type: "image_url", image_url: { url: "asset://asset-1" }, role: "first_frame" };
 * ```
 */
export type ArkContentItem =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string }; role: ArkImageRole }
  | ArkMediaItem;

/**
 * The task body POSTed to ark.
 *
 * @example
 * ```ts
 * const body: ArkVideoBody = {
 *   model: "dreamina-seedance-2-0-260128", content: [{ type: "text", text: "p" }],
 *   ratio: "9:16", duration: 5, resolution: "720p", generate_audio: false, watermark: false
 * };
 * ```
 */
export type ArkVideoBody = ArkPassthrough & {
  /** Ark model id. */
  model: string;
  /** Prompt, then frames, then reference images, then reference media. */
  content: ArkContentItem[];
  /** Aspect ratio. */
  ratio: string;
  /** Clip length, seconds. */
  duration: number;
  /** Output resolution. */
  resolution: string;
  /** Whether ark generates audio. */
  generate_audio: boolean;
};

/**
 * A request checked against the model, with defaults applied.
 *
 * @example
 * ```ts
 * const checked: CheckedVideoRequest = { seconds: 5, resolution: "720p", ratio: "9:16", audio: false, media: [], params: {} };
 * ```
 */
export type CheckedVideoRequest = {
  /** Clip length, seconds. */
  seconds: number;
  /** Output resolution. */
  resolution: string;
  /** Aspect ratio. */
  ratio: string;
  /** Whether ark generates audio. */
  audio: boolean;
  /** Reference media from `params.refUrls`, in array order. */
  media: ArkMediaItem[];
  /** The allow-listed passthrough params. */
  params: ArkPassthrough;
};

/**
 * One request input read from disk: a plain local image as a data URI, or an
 * asset ref as its record.
 *
 * @example
 * ```ts
 * const input: ReadInput = { kind: "image", url: "data:image/png;base64,AQID" };
 * ```
 */
export type ReadInput = { kind: "image"; url: string } | { kind: "asset"; record: AssetRecord };

/**
 * Every input of a request, read.
 *
 * @example
 * ```ts
 * const inputs: ReadInputs = { image: { kind: "image", url: "data:image/png;base64,AQID" }, endImage: undefined, refs: [] };
 * ```
 */
export type ReadInputs = {
  /** First frame, when the request has one. */
  image: ReadInput | undefined;
  /** Last frame, when the request has one. */
  endImage: ReadInput | undefined;
  /** Refs, in request order. */
  refs: ReadInput[];
};

/** `ratio` when the request names none (the `VideoRequest.aspect` default). */
const DEFAULT_RATIO = "9:16";

/** refUrls path extensions sent as a reference video. */
const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([".mp4", ".mov"]);

/** refUrls path extensions sent as a reference audio. */
const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([".mp3", ".wav"]);

/** The error for a video or audio ref given as a local file. */
const LOCAL_MEDIA_ERROR =
  "[ai] ark takes video and audio references by public URL only.\n  Pass them in params.refUrls.";

/** The error for a `params.refUrls` that is not a list of strings. */
const REF_URLS_SHAPE_ERROR =
  '[ai] ark params.refUrls must be a list of URLs.\n  Pass refUrls: ["https://.../clip.mp4"].';

/**
 * Whether a file is a registered asset (a `$ref` to an asset item).
 *
 * @param file - A request input.
 * @returns True for `ASSET_MIME`.
 * @example
 * ```ts
 * isAssetFile({ path: "a.json", mimeType: "application/vnd.moku.asset+json", hash: "h" }); // => true
 * ```
 */
export function isAssetFile(file: VideoFile): boolean {
  return file.mimeType === ASSET_MIME;
}

/**
 * Whether a file is a video or audio file.
 *
 * @param file - A request input.
 * @returns True for a `video/*` or `audio/*` MIME type.
 * @example
 * ```ts
 * isMediaFile({ path: "a.mp3", mimeType: "audio/mpeg", hash: "h" }); // => true
 * ```
 */
function isMediaFile(file: VideoFile): boolean {
  return file.mimeType.startsWith("video/") || file.mimeType.startsWith("audio/");
}

/**
 * Whether an input is a plain local image: present, not an asset, not media.
 *
 * @param file - A request input, if any.
 * @returns True for a plain local image.
 * @example
 * ```ts
 * isPlainImage({ path: "a.png", mimeType: "image/png", hash: "h" }); // => true
 * ```
 */
function isPlainImage(file: VideoFile | undefined): boolean {
  return file !== undefined && !isAssetFile(file) && !isMediaFile(file);
}

/**
 * Whether the request carries at least one plain local image (`image`,
 * `endImage` or a ref that is not an asset). Picks the face-refusal message.
 *
 * @param request - The video request.
 * @returns True when a plain local image is sent.
 * @example
 * ```ts
 * hasLocalImage({ model: "m", prompt: "p", image: { path: "a.png", mimeType: "image/png", hash: "h" } }); // => true
 * ```
 */
export function hasLocalImage(request: VideoRequest): boolean {
  const inputs = [request.image, request.endImage, ...(request.refs ?? [])];
  return inputs.some(file => isPlainImage(file));
}

/**
 * The lowercase path extension of a https URL.
 *
 * @param entry - A refUrls entry.
 * @returns The extension (`".mp4"`), or undefined for a non-https or unparsable URL.
 * @example
 * ```ts
 * httpsExtensionOf("https://cdn.example/A.MOV?sig=1"); // => ".mov"
 * ```
 */
function httpsExtensionOf(entry: string): string | undefined {
  if (!URL.canParse(entry)) return undefined;
  const url = new URL(entry);
  if (url.protocol !== "https:") return undefined;
  return path.posix.extname(url.pathname).toLowerCase();
}

/**
 * Maps one refUrls entry to its content item by the URL's path extension.
 *
 * @param entry - A refUrls entry.
 * @returns The reference video or audio item.
 * @throws {Error} A plain two-line error for a non-string, a non-https URL or another extension.
 * @example
 * ```ts
 * mediaItemOf("https://cdn.example/rain.mp3"); // => { type: "audio_url", audio_url: { url: "https://cdn.example/rain.mp3" }, role: "reference_audio" }
 * ```
 */
function mediaItemOf(entry: unknown): ArkMediaItem {
  if (typeof entry !== "string") throw new Error(REF_URLS_SHAPE_ERROR);

  const extension = httpsExtensionOf(entry) ?? "";
  if (VIDEO_EXTENSIONS.has(extension)) {
    return { type: "video_url", video_url: { url: entry }, role: "reference_video" };
  }
  if (AUDIO_EXTENSIONS.has(extension)) {
    return { type: "audio_url", audio_url: { url: entry }, role: "reference_audio" };
  }
  throw new Error(
    `[ai] ark refUrls entry "${entry}" is not a https .mp4, .mov, .mp3 or .wav URL.\n  Host the file and pass its public link.`
  );
}

/**
 * Maps `params.refUrls` to content items and checks the counts against the
 * model's video and audio limits.
 *
 * @param model - The catalog row.
 * @param refUrls - `params.refUrls`, as given.
 * @returns Reference media items, in array order.
 * @throws {Error} A plain two-line error for a bad entry or a count over a limit.
 * @example
 * ```ts
 * mediaItemsOf(resolveArkModel("dreamina-seedance-2-0-260128", "intl"), undefined); // => []
 * ```
 */
function mediaItemsOf(model: ArkVideoModel, refUrls: unknown): ArkMediaItem[] {
  if (refUrls === undefined) return [];
  if (!Array.isArray(refUrls)) throw new Error(REF_URLS_SHAPE_ERROR);

  const items = refUrls.map(entry => mediaItemOf(entry));
  const videos = items.filter(item => item.type === "video_url").length;
  const audios = items.length - videos;
  if (videos > model.maxRefVideos) {
    throw new Error(
      `[ai] Model ${model.id} takes at most ${model.maxRefVideos} reference videos.\n  Got ${videos}; drop some refUrls.`
    );
  }
  if (audios > model.maxRefAudios) {
    throw new Error(
      `[ai] Model ${model.id} takes at most ${model.maxRefAudios} reference audios.\n  Got ${audios}; drop some refUrls.`
    );
  }
  return items;
}

/**
 * Whether `params.refUrls` holds a reference video URL. Picks the
 * with-video-input price.
 *
 * @param request - The video request.
 * @returns True when a https .mp4 or .mov URL is in refUrls.
 * @example
 * ```ts
 * hasVideoReferenceUrl({ model: "m", prompt: "p", params: { refUrls: ["https://cdn.example/walk.mp4"] } }); // => true
 * ```
 */
export function hasVideoReferenceUrl(request: VideoRequest): boolean {
  const refUrls = request.params?.refUrls;
  if (!Array.isArray(refUrls)) return false;
  return refUrls.some(
    entry => typeof entry === "string" && VIDEO_EXTENSIONS.has(httpsExtensionOf(entry) ?? "")
  );
}

/**
 * Checks `request.aspect` against the ratios ark takes.
 *
 * @param aspect - `request.aspect`; 9:16 when undefined.
 * @returns The ratio.
 * @throws {Error} A plain two-line error listing the ratios.
 * @example
 * ```ts
 * checkRatio(undefined); // => "9:16"
 * ```
 */
function checkRatio(aspect: string | undefined): string {
  const ratio = aspect ?? DEFAULT_RATIO;
  if (!ARK_RATIOS.includes(ratio)) {
    throw new Error(
      `[ai] ark ratio "${ratio}" is not supported.\n  Use one of: ${ARK_RATIOS.join(", ")}.`
    );
  }
  return ratio;
}

/**
 * Whether a `params` key is one ark takes.
 *
 * @param key - A `params` key.
 * @returns True for a key in {@link ARK_PARAMS}.
 * @example
 * ```ts
 * isArkParameter("cfg_scale"); // => false
 * ```
 */
function isArkParameter(key: string): key is ArkParameterName {
  return (ARK_PARAMS as readonly string[]).includes(key);
}

/**
 * Picks the allow-listed passthrough params out of `request.params`.
 *
 * @param model - The catalog row.
 * @param params - `request.params`.
 * @returns The passthrough params (`refUrls` excluded).
 * @throws {Error} A plain two-line error for an unknown key, or a seed on a model without seed.
 * @example
 * ```ts
 * checkParameters(resolveArkModel("dreamina-seedance-2-0-260128", "intl"), { watermark: true, refUrls: [] }); // => { watermark: true }
 * ```
 */
function checkParameters(model: ArkVideoModel, params: Record<string, unknown>): ArkPassthrough {
  const passthrough: ArkPassthrough = {};
  for (const [key, value] of Object.entries(params)) {
    if (!isArkParameter(key)) {
      throw new Error(`[ai] Unknown ark param "${key}".\n  Allowed: ${ARK_PARAMS.join(", ")}.`);
    }
    if (key === "refUrls") continue;
    if (key === "seed" && !model.supportsSeed) {
      throw new Error(`[ai] Model ${model.id} takes no seed.\n  Remove params.seed.`);
    }
    passthrough[key] = value;
  }
  return passthrough;
}

/**
 * Checks the refs: no local video or audio, and no more image refs (plain
 * images and asset refs together) than the model takes.
 *
 * @param model - The catalog row.
 * @param references - `request.refs`.
 * @throws {Error} A plain two-line error for a local video/audio ref or too many refs.
 * @example
 * ```ts
 * checkReferences(resolveArkModel("dreamina-seedance-2-0-260128", "intl"), [{ path: "a.mp4", mimeType: "video/mp4", hash: "h" }]);
 * // throws: "[ai] ark takes video and audio references by public URL only.\n  Pass them in params.refUrls."
 * ```
 */
function checkReferences(model: ArkVideoModel, references: readonly VideoFile[]): void {
  if (references.some(file => isMediaFile(file))) throw new Error(LOCAL_MEDIA_ERROR);
  if (references.length > model.maxRefImages) {
    throw new Error(
      `[ai] Model ${model.id} takes at most ${model.maxRefImages} reference images.\n  Got ${references.length}; drop some refs.`
    );
  }
}

/**
 * Checks a request against the model, with no I/O: seconds, resolution,
 * ratio, params, refs and refUrls. Every failure is a plain two-line error,
 * thrown before any file is read and before any call.
 *
 * @param model - The catalog row (already checked for the region).
 * @param request - The video request.
 * @returns The checked request, defaults applied.
 * @throws {Error} The first broken rule.
 * @example
 * ```ts
 * checkVideoRequest(resolveArkModel("dreamina-seedance-2-0-260128", "intl"), { model: "dreamina-seedance-2-0-260128", prompt: "p" });
 * // => { seconds: 5, resolution: "720p", ratio: "9:16", audio: false, media: [], params: {} }
 * ```
 */
export function checkVideoRequest(
  model: ArkVideoModel,
  request: VideoRequest
): CheckedVideoRequest {
  // Check clip, ratio and params against the model.
  const clip = checkClip(model, request);
  const ratio = checkRatio(request.aspect);
  const params = request.params ?? {};
  const passthrough = checkParameters(model, params);

  // Check refs, then assemble the checked request.
  checkReferences(model, request.refs ?? []);
  const media = mediaItemsOf(model, params.refUrls);
  return {
    ...clip,
    ratio,
    audio: model.supportsAudio && request.audio === true,
    media,
    params: passthrough
  };
}

/**
 * Reads one input: an asset ref as its record, anything else as a data URI.
 *
 * @param file - A request input.
 * @returns The read input.
 * @throws {Error} A plain two-line error when the file cannot be read, or the contract error for a bad asset record.
 */
async function readInput(file: VideoFile): Promise<ReadInput> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(file.path));
  } catch {
    throw new Error(
      `[ai] Cannot read ark input file "${file.path}".\n  Check that the $ref or $file it came from still exists.`
    );
  }
  if (isAssetFile(file)) return { kind: "asset", record: parseAssetRecord(bytes) };
  return {
    kind: "image",
    url: `data:${file.mimeType};base64,${Buffer.from(bytes).toString("base64")}`
  };
}

/**
 * Reads every input of a request: first frame, end frame and refs.
 *
 * @param request - The video request (files resolved).
 * @returns The read inputs.
 * @throws {Error} The first read or parse error.
 */
export async function readInputs(request: VideoRequest): Promise<ReadInputs> {
  const image = request.image === undefined ? undefined : await readInput(request.image);
  const endImage = request.endImage === undefined ? undefined : await readInput(request.endImage);
  const references = await Promise.all((request.refs ?? []).map(file => readInput(file)));
  return { image, endImage, refs: references };
}

/**
 * The asset records among the read inputs, in body order.
 *
 * @param inputs - The read inputs.
 * @returns Asset records (duplicates kept).
 * @example
 * ```ts
 * assetRecordsOf({ image: { kind: "image", url: "data:image/png;base64,AQID" }, endImage: undefined, refs: [] }); // => []
 * ```
 */
export function assetRecordsOf(inputs: ReadInputs): AssetRecord[] {
  const records: AssetRecord[] = [];
  for (const input of [inputs.image, inputs.endImage, ...inputs.refs]) {
    if (input?.kind === "asset") records.push(input.record);
  }
  return records;
}

/**
 * The content item of one read image input.
 *
 * @param input - The read input.
 * @param role - Its role.
 * @returns The image item: the data URI, or `asset://<assetId>`.
 * @example
 * ```ts
 * imageItem({ kind: "image", url: "data:image/png;base64,AQID" }, "first_frame"); // => { type: "image_url", image_url: { url: "data:image/png;base64,AQID" }, role: "first_frame" }
 * ```
 */
function imageItem(input: ReadInput, role: ArkImageRole): ArkContentItem {
  const url = input.kind === "asset" ? `asset://${input.record.assetId}` : input.url;
  return { type: "image_url", image_url: { url }, role };
}

/**
 * Assembles the task body: the prompt, the first frame, the last frame, the
 * reference images in request order, then the reference media in refUrls
 * order; `watermark` defaults to false and the passthrough params go last.
 *
 * @param model - The catalog row.
 * @param prompt - The prompt, sent as given.
 * @param checked - The checked request.
 * @param inputs - The read inputs.
 * @returns The body.
 * @example
 * ```ts
 * const checked = { seconds: 5, resolution: "720p", ratio: "9:16", audio: false, media: [], params: {} };
 * buildArkBody(resolveArkModel("dreamina-seedance-2-0-260128", "intl"), "p", checked, { image: undefined, endImage: undefined, refs: [] });
 * // => { model: "dreamina-seedance-2-0-260128", content: [{ type: "text", text: "p" }], ratio: "9:16", duration: 5, resolution: "720p", generate_audio: false, watermark: false }
 * ```
 */
export function buildArkBody(
  model: ArkVideoModel,
  prompt: string,
  checked: CheckedVideoRequest,
  inputs: ReadInputs
): ArkVideoBody {
  const content: ArkContentItem[] = [{ type: "text", text: prompt }];
  if (inputs.image !== undefined) content.push(imageItem(inputs.image, "first_frame"));
  if (inputs.endImage !== undefined) content.push(imageItem(inputs.endImage, "last_frame"));
  for (const reference of inputs.refs) content.push(imageItem(reference, "reference_image"));
  content.push(...checked.media);

  return {
    model: model.id,
    content,
    ratio: checked.ratio,
    duration: checked.seconds,
    resolution: checked.resolution,
    generate_audio: checked.audio,
    watermark: false,
    ...checked.params
  };
}

/**
 * Logs `ark:negative:ignored` the first time a request carries `negative`
 * in this process: ark takes no negative prompt, so it is dropped.
 *
 * @param ctx - Plugin context (state, log).
 * @param request - The video request.
 */
export function warnNegativeOnce(ctx: ArkContext, request: VideoRequest): void {
  const hasNegative = request.negative !== undefined && request.negative !== "";
  if (!hasNegative || ctx.state.negativeWarned) return;

  ctx.state.negativeWarned = true;
  ctx.log.warn("ark:negative:ignored", { model: request.model });
}
