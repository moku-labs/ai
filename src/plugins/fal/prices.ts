/**
 * @file fal bundled price table — data module (USD per second of video, plus
 * reference-token rates), and the one lookup that estimate and actual cost
 * share. An alias or resolution without a price throws: a paid job never runs
 * at an unknown price (D13).
 */
import { readFileSync } from "node:fs";
import type { VideoFile, VideoRequest } from "../video/contract";
import { imageSize } from "./image-size";
import { modelAudio, modelResolution, requestSeconds, resolveFalModel } from "./models";
import type { FalContext } from "./types";

/**
 * Bundled USD-per-second prices from the fal model pages. Keys are
 * `<alias>@<resolution>`, `<alias>+audio` or `<alias>`. A model billed for
 * reference tokens also has `<alias>#refTokensIncluded` (tokens free per
 * request) and `<alias>#refTokenUsdPer1k`. Override via `config.priceOverrides`.
 *
 * @example
 * ```ts
 * bundledPrices["minimax-h3@768P"]; // => 0.06
 * ```
 */
export const bundledPrices: Readonly<Record<string, number>> = {
  "seedance-2.5@480p": 0.2205,
  "seedance-2.5@720p": 0.473,
  "seedance-2.5-ref@480p": 0.2205,
  "seedance-2.5-ref@720p": 0.473,
  "minimax-h3@480P": 0.05,
  "minimax-h3@768P": 0.06,
  "minimax-h3@2K": 0.13,
  "minimax-h3@4K": 0.16,
  "kling-3-pro": 0.112,
  "kling-3-pro+audio": 0.168,
  "kling-o3-ref": 0.112,
  "kling-o3-ref+audio": 0.14
};

/** Cost precision: results are rounded to micro-dollars so 5 x 0.06 is 0.3, not 0.30000000000000004. */
const MICRO_DOLLARS = 1_000_000;

/**
 * Reference-image tokens by aspect ratio (long side / short side), from the
 * fal MiniMax H3 Max pricing table. An image takes the first row whose ratio
 * is at least its own (within {@link RATIO_TOLERANCE}).
 */
const IMAGE_TOKENS_BY_RATIO: readonly (readonly [ratio: number, tokens: number])[] = [
  [1, 1024],
  [4 / 3, 1376],
  [16 / 9, 1824],
  [5 / 2, 2560]
];

/** Rounding slack when matching an image's ratio to a table row (1366 x 768 is 16:9). */
const RATIO_TOLERANCE = 0.01;

/** Tokens for an image whose ratio is unknown: the most a fal-accepted image costs (5:2). */
const WORST_CASE_IMAGE_TOKENS = 2560;

/** Tokens for the audio refs of one request: fal's 15 s combined maximum at ~80 tokens per second. */
const AUDIO_REF_TOKENS = 1200;

/**
 * Merges the bundled table with config overrides (overrides win).
 *
 * @param overrides - `config.priceOverrides`.
 * @returns The effective price table.
 * @example
 * ```ts
 * mergePrices({ "kling-3-pro": 0.2 })["kling-3-pro"]; // => 0.2
 * ```
 */
export function mergePrices(overrides: Record<string, number>): Record<string, number> {
  return { ...bundledPrices, ...overrides };
}

/**
 * Resolves the effective price table, computing and caching it into
 * `ctx.state.prices` on first use.
 *
 * @param ctx - Plugin context (`config.priceOverrides`, `state.prices`).
 * @returns The effective price table.
 * @example
 * ```ts
 * const prices = resolvePrices(ctx);
 * ```
 */
export function resolvePrices(ctx: FalContext): Record<string, number> {
  if (ctx.state.prices === null) {
    ctx.state.prices = mergePrices(ctx.config.priceOverrides);
  }
  return ctx.state.prices;
}

/**
 * The price keys to try, in order: `<alias>@<resolution>`, then
 * `<alias>+audio` when audio is on, then `<alias>`.
 *
 * @param alias - The model alias.
 * @param resolution - The effective resolution, if any.
 * @param audio - Whether audio is on.
 * @returns Keys in lookup order.
 * @example
 * ```ts
 * priceKeys("kling-3-pro", undefined, true); // => ["kling-3-pro+audio", "kling-3-pro"]
 * ```
 */
function priceKeys(alias: string, resolution: string | undefined, audio: boolean): string[] {
  const keys: string[] = [];
  if (resolution !== undefined) keys.push(`${alias}@${resolution}`);
  if (audio) keys.push(`${alias}+audio`);
  keys.push(alias);
  return keys;
}

/**
 * Finds the USD-per-second price for a model variant.
 *
 * @param prices - The effective price table.
 * @param alias - The model alias.
 * @param resolution - The effective resolution, if any.
 * @param audio - Whether audio is on.
 * @returns USD per second.
 * @throws {Error} The pinned two-line "no price" error when no key matches.
 * @example
 * ```ts
 * lookupPrice(mergePrices({}), "minimax-h3", "768P", false); // => 0.06
 * ```
 */
export function lookupPrice(
  prices: Readonly<Record<string, number>>,
  alias: string,
  resolution: string | undefined,
  audio: boolean
): number {
  for (const key of priceKeys(alias, resolution, audio)) {
    const price = prices[key];
    if (price !== undefined) return price;
  }
  throw new Error(
    `[ai] No price for fal model "${alias}" (${resolution ?? "default"}, audio ${audio ? "on" : "off"}).\n  Add it to fal priceOverrides.`
  );
}

/**
 * A request image or ref at estimate time: a resolved file, or still the
 * build-file reference the runner resolves before submit (the runner
 * estimates the unresolved request).
 *
 * @example
 * ```ts
 * const input: EstimateInput = { $ref: "s01.key" };
 * ```
 */
type EstimateInput = VideoFile | { $ref: string } | { $file: string };

/**
 * Whether a request input is a resolved file rather than a `$ref` / `$file`.
 *
 * @param value - A request image or ref.
 * @returns True for a resolved `VideoFile`.
 * @example
 * ```ts
 * isResolvedFile({ path: "a.png", mimeType: "image/png", hash: "h" }); // => true
 * ```
 */
function isResolvedFile(value: EstimateInput): value is VideoFile {
  return "path" in value && "mimeType" in value && "hash" in value;
}

/**
 * Reference tokens of one image, from the aspect ratio in its header.
 *
 * @param file - The image, resolved or not.
 * @returns Tokens; the worst case when the file is unresolved or unreadable.
 * @example
 * ```ts
 * imageTokens({ path: "square.png", mimeType: "image/png", hash: "h" }); // => 1024
 * ```
 */
function imageTokens(file: EstimateInput): number {
  if (!isResolvedFile(file)) return WORST_CASE_IMAGE_TOKENS;

  let size: ReturnType<typeof imageSize>;
  try {
    size = imageSize(new Uint8Array(readFileSync(file.path)));
  } catch {
    return WORST_CASE_IMAGE_TOKENS;
  }
  if (size === undefined) return WORST_CASE_IMAGE_TOKENS;

  const ratio = Math.max(size.width, size.height) / Math.min(size.width, size.height);
  const row = IMAGE_TOKENS_BY_RATIO.find(([rowRatio]) => ratio <= rowRatio + RATIO_TOLERANCE);
  return row === undefined ? WORST_CASE_IMAGE_TOKENS : row[1];
}

/**
 * Whether a ref is a resolved audio ref.
 *
 * @param file - A request ref.
 * @returns True for a resolved file with an `audio/*` MIME type.
 * @example
 * ```ts
 * isAudioFile({ path: "v.mp3", mimeType: "audio/mpeg", hash: "h" }); // => true
 * ```
 */
function isAudioFile(file: EstimateInput): boolean {
  return isResolvedFile(file) && file.mimeType.startsWith("audio/");
}

/**
 * Reference tokens of a request: every image (the first frame and each
 * non-audio ref, unresolved refs counted as images) plus a flat audio amount
 * when any audio ref is present.
 *
 * @param request - The video request.
 * @returns Total reference tokens.
 * @example
 * ```ts
 * referenceTokens({ model: "minimax-h3-max-ref", prompt: "p", image: square }); // => 1024
 * ```
 */
function referenceTokens(request: VideoRequest): number {
  const references: readonly EstimateInput[] = request.refs ?? [];
  const images: EstimateInput[] = references.filter(file => !isAudioFile(file));
  if (request.image !== undefined) images.unshift(request.image);

  const imageTotal = images.reduce<number>((total, file) => total + imageTokens(file), 0);
  const audioTotal = references.some(file => isAudioFile(file)) ? AUDIO_REF_TOKENS : 0;
  return imageTotal + audioTotal;
}

/**
 * USD for reference tokens above the included allowance, for a model with a
 * `<alias>#refTokenUsdPer1k` price; 0 for every other model.
 *
 * @param prices - The effective price table.
 * @param alias - The model alias.
 * @param request - The video request.
 * @returns Surcharge in USD (unrounded).
 * @example
 * ```ts
 * refTokenCostUsd(mergePrices({}), "minimax-h3-max-ref", request); // => 0.02048 for five square images
 * ```
 */
function refTokenCostUsd(
  prices: Readonly<Record<string, number>>,
  alias: string,
  request: VideoRequest
): number {
  const usdPer1k = prices[`${alias}#refTokenUsdPer1k`];
  if (usdPer1k === undefined) return 0;

  const included = prices[`${alias}#refTokensIncluded`] ?? 0;
  const billable = Math.max(0, referenceTokens(request) - included);
  return (billable * usdPer1k) / 1000;
}

/**
 * Cost of a video request: seconds x USD per second of its model variant,
 * plus the reference-token surcharge for models billed that way. Estimate and
 * actual cost both come from here; reference images are sized from their
 * file headers once resolved, and priced at the worst case before.
 *
 * @param ctx - Plugin context (effective price table).
 * @param request - The video request.
 * @returns Cost in USD, rounded to micro-dollars.
 * @throws {Error} For an unknown alias or a variant without a price.
 * @example
 * ```ts
 * videoCostUsd(ctx, { model: "minimax-h3", prompt: "push-in", seconds: 5 }); // => 0.3
 * ```
 */
export function videoCostUsd(ctx: FalContext, request: VideoRequest): number {
  const model = resolveFalModel(request.model);
  const prices = resolvePrices(ctx);
  const perSecond = lookupPrice(
    prices,
    model.alias,
    modelResolution(model, request),
    modelAudio(model, request)
  );
  const usd = requestSeconds(request) * perSecond + refTokenCostUsd(prices, model.alias, request);
  return Math.round(usd * MICRO_DOLLARS) / MICRO_DOLLARS;
}
