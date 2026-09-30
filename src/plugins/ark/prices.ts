/**
 * @file ark cost math: tokens of a clip, the USD price per 1M output tokens
 * (catalog price in the region currency, or a `priceOverrides` entry in USD),
 * cost, and the price of one Seedream image. Estimate and actual cost share
 * it, so they always agree on price.
 */
import type { ArkImageModel } from "./image/models";
import type { ArkVideoModel } from "./models";
import { checkClip, DEFAULT_RESOLUTION } from "./models";
import { arkRegions } from "./regions";
import type { Config, EstimateRequest } from "./types";

/**
 * The config fields cost math reads.
 *
 * @example
 * ```ts
 * const config: PriceConfig = { priceOverrides: {}, cnyPerUsd: 7.1 };
 * ```
 */
export type PriceConfig = Pick<Config, "priceOverrides" | "cnyPerUsd">;

/** Frames per second of a Seedance clip, for the token estimate. */
export const FRAMES_PER_SECOND = 24;

/** Pixels per output token. */
const PIXELS_PER_TOKEN = 1024;

/** Tokens per price unit (prices are per 1M tokens). */
const TOKENS_PER_PRICE_UNIT = 1_000_000;

/** Cost precision: results are rounded to micro-dollars. */
const MICRO_DOLLARS = 1_000_000;

/** The resolution priced with `price1080` when a row has one. */
const PRICE_1080_RESOLUTION = "1080p";

/** A resolution named by its line count, like `"540p"`. */
const LINES_RESOLUTION = /^(\d+)p$/i;

/**
 * Output pixel size of each resolution, for the token estimate. 16:9 sizes,
 * verified against billed tokens; 9:16 has the same area. Other ratios use
 * the same area: the per-ratio size table is not in the public docs.
 *
 * @example
 * ```ts
 * RESOLUTION_SIZES["480p"]; // => { width: 864, height: 496 }
 * ```
 */
export const RESOLUTION_SIZES: Readonly<Record<string, { width: number; height: number }>> = {
  "480p": { width: 864, height: 496 },
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 }
};

/**
 * Estimated output tokens of a clip: `w × h × (24 × seconds + 1) / 1024`,
 * rounded down. Matches the billed tokens of live runs: 480p 5 s is 50,638,
 * 1080p 5 s is 245,025.
 *
 * @param resolution - A resolution with a known pixel size.
 * @param seconds - Clip length.
 * @returns Tokens.
 * @throws {Error} A plain two-line error for a resolution without a pixel size.
 * @example
 * ```ts
 * estimateTokens("720p", 5); // => 108900
 * ```
 */
export function estimateTokens(resolution: string, seconds: number): number {
  const size = RESOLUTION_SIZES[resolution];
  if (size === undefined) {
    throw new Error(
      `[ai] ark has no pixel size for resolution "${resolution}".\n  Use 480p, 720p or 1080p.`
    );
  }
  const frames = FRAMES_PER_SECOND * seconds + 1;
  return Math.floor((size.width * size.height * frames) / PIXELS_PER_TOKEN);
}

/**
 * The listed resolution nearest to any resolution: itself when listed, the
 * nearest line count for `"<n>p"`, else the default 720p. Lets the cost
 * fallback price a task whose resolution the table does not list.
 *
 * @param resolution - A resolution, listed or not.
 * @returns A key of {@link RESOLUTION_SIZES}.
 * @example
 * ```ts
 * nearestResolution("540p"); // => "480p"
 * ```
 */
export function nearestResolution(resolution: string): string {
  if (RESOLUTION_SIZES[resolution] !== undefined) return resolution;

  const lines = Number(LINES_RESOLUTION.exec(resolution)?.[1]);
  if (Number.isNaN(lines)) return DEFAULT_RESOLUTION;

  // The listed resolution whose line count is closest; the first one wins a tie.
  let nearest = DEFAULT_RESOLUTION;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const listed of Object.keys(RESOLUTION_SIZES)) {
    const distance = Math.abs(Number.parseInt(listed, 10) - lines);
    if (distance < nearestDistance) {
      nearest = listed;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/**
 * USD per 1M output tokens for a model: the `priceOverrides` entry when
 * there is one (already USD), else the catalog price (`price1080` at 1080p
 * when the row has one), converted from CNY with `cnyPerUsd` on cn.
 *
 * @param config - Price overrides and the CNY rate.
 * @param model - The catalog row.
 * @param withVideoInput - Whether the request sends a video reference.
 * @param resolution - The clip's resolution.
 * @returns USD per 1M tokens.
 * @example
 * ```ts
 * pricePerMillionUsd({ priceOverrides: {}, cnyPerUsd: 7.1 }, resolveArkModel("dreamina-seedance-2-0-260128", "intl"), false, "1080p"); // => 7.7
 * ```
 */
export function pricePerMillionUsd(
  config: PriceConfig,
  model: ArkVideoModel,
  withVideoInput: boolean,
  resolution: string
): number {
  const override = config.priceOverrides[model.id];
  if (override !== undefined) return override;

  const table =
    resolution === PRICE_1080_RESOLUTION ? (model.price1080 ?? model.price) : model.price;
  const price = withVideoInput ? table.withVideoInput : table.base;
  return arkRegions[model.region].currency === "CNY" ? price / config.cnyPerUsd : price;
}

/**
 * Cost of a number of output tokens, in USD, rounded to micro-dollars.
 *
 * @param config - Price overrides and the CNY rate.
 * @param model - The catalog row.
 * @param tokens - Output tokens (`usage.completion_tokens`).
 * @param withVideoInput - Whether the request sent a video reference.
 * @param resolution - The clip's resolution (picks `price1080`).
 * @returns USD.
 * @example
 * ```ts
 * costUsd({ priceOverrides: {}, cnyPerUsd: 7.1 }, resolveArkModel("dreamina-seedance-2-0-260128", "intl"), 108900, false, "720p"); // => 0.7623
 * ```
 */
export function costUsd(
  config: PriceConfig,
  model: ArkVideoModel,
  tokens: number,
  withVideoInput: boolean,
  resolution: string
): number {
  const price = pricePerMillionUsd(config, model, withVideoInput, resolution);
  return roundUsd((tokens / TOKENS_PER_PRICE_UNIT) * price);
}

/**
 * Estimated cost of a request, before any file is resolved: the estimated
 * tokens of its seconds and resolution at the base price.
 *
 * @param config - Price overrides and the CNY rate.
 * @param model - The catalog row.
 * @param request - Seconds and resolution, checked against the model.
 * @returns USD.
 * @throws {Error} The model's seconds or resolution error.
 * @example
 * ```ts
 * estimateUsd({ priceOverrides: {}, cnyPerUsd: 7.1 }, resolveArkModel("dreamina-seedance-2-0-260128", "intl"), {}); // => 0.7623
 * ```
 */
export function estimateUsd(
  config: PriceConfig,
  model: ArkVideoModel,
  request: Pick<EstimateRequest, "seconds" | "resolution">
): number {
  const clip = checkClip(model, request);
  const tokens = estimateTokens(clip.resolution, clip.seconds);
  return costUsd(config, model, tokens, false, clip.resolution);
}

/**
 * Cost of Seedream images, in USD: `priceOverrides[id]` (USD per image) when
 * set, else the catalog `priceUsd`, times the image count.
 *
 * @param config - Price overrides.
 * @param model - The image catalog row.
 * @param images - Images billed (`usage.generated_images`).
 * @returns USD, rounded to micro-dollars.
 * @example
 * ```ts
 * imageCostUsd({ priceOverrides: {}, cnyPerUsd: 7.1 }, resolveArkImageModel(undefined, "intl"), 1); // => 0.035
 * ```
 */
export function imageCostUsd(config: PriceConfig, model: ArkImageModel, images: number): number {
  const perImage = config.priceOverrides[model.id] ?? model.priceUsd;
  return roundUsd(perImage * images);
}

/**
 * Rounds USD to micro-dollars.
 *
 * @param usd - An amount in USD.
 * @returns The rounded amount.
 * @example
 * ```ts
 * roundUsd(0.354_466_1); // => 0.354466
 * ```
 */
function roundUsd(usd: number): number {
  return Math.round(usd * MICRO_DOLLARS) / MICRO_DOLLARS;
}
