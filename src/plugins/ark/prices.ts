/**
 * @file ark cost math: tokens of a clip, the USD price per 1M output tokens
 * (catalog price in the region currency, or a `priceOverrides` entry in USD),
 * and cost. Estimate and actual cost share it, so they always agree on price.
 */
import type { ArkVideoModel } from "./models";
import { checkClip } from "./models";
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

/**
 * Output pixel size of each resolution, for the token estimate.
 *
 * @example
 * ```ts
 * RESOLUTION_SIZES["720p"]; // => { width: 1280, height: 720 }
 * ```
 */
export const RESOLUTION_SIZES: Readonly<Record<string, { width: number; height: number }>> = {
  "480p": { width: 864, height: 480 },
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 }
};

/**
 * Estimated output tokens of a clip: `w × h × 24 × seconds / 1024`.
 *
 * @param resolution - A resolution with a known pixel size.
 * @param seconds - Clip length.
 * @returns Tokens.
 * @throws {Error} A plain two-line error for a resolution without a pixel size.
 * @example
 * ```ts
 * estimateTokens("720p", 5); // => 108000
 * ```
 */
export function estimateTokens(resolution: string, seconds: number): number {
  const size = RESOLUTION_SIZES[resolution];
  if (size === undefined) {
    throw new Error(
      `[ai] ark has no pixel size for resolution "${resolution}".\n  Use 480p, 720p or 1080p.`
    );
  }
  return (size.width * size.height * FRAMES_PER_SECOND * seconds) / PIXELS_PER_TOKEN;
}

/**
 * USD per 1M output tokens for a model: the `priceOverrides` entry when
 * there is one (already USD), else the catalog price, converted from CNY
 * with `cnyPerUsd` on cn.
 *
 * @param config - Price overrides and the CNY rate.
 * @param model - The catalog row.
 * @param withVideoInput - Whether the request sends a video reference.
 * @returns USD per 1M tokens.
 * @example
 * ```ts
 * pricePerMillionUsd({ priceOverrides: {}, cnyPerUsd: 7.1 }, resolveArkModel("dreamina-seedance-2-0-260128", "intl"), false); // => 7
 * ```
 */
export function pricePerMillionUsd(
  config: PriceConfig,
  model: ArkVideoModel,
  withVideoInput: boolean
): number {
  const override = config.priceOverrides[model.id];
  if (override !== undefined) return override;

  const price = withVideoInput ? model.price.withVideoInput : model.price.base;
  return arkRegions[model.region].currency === "CNY" ? price / config.cnyPerUsd : price;
}

/**
 * Cost of a number of output tokens, in USD, rounded to micro-dollars.
 *
 * @param config - Price overrides and the CNY rate.
 * @param model - The catalog row.
 * @param tokens - Output tokens (`usage.completion_tokens`).
 * @param withVideoInput - Whether the request sent a video reference.
 * @returns USD.
 * @example
 * ```ts
 * costUsd({ priceOverrides: {}, cnyPerUsd: 7.1 }, resolveArkModel("dreamina-seedance-2-0-260128", "intl"), 108900, false); // => 0.7623
 * ```
 */
export function costUsd(
  config: PriceConfig,
  model: ArkVideoModel,
  tokens: number,
  withVideoInput: boolean
): number {
  const usd = (tokens / TOKENS_PER_PRICE_UNIT) * pricePerMillionUsd(config, model, withVideoInput);
  return Math.round(usd * MICRO_DOLLARS) / MICRO_DOLLARS;
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
 * estimateUsd({ priceOverrides: {}, cnyPerUsd: 7.1 }, resolveArkModel("dreamina-seedance-2-0-260128", "intl"), {}); // => 0.756
 * ```
 */
export function estimateUsd(
  config: PriceConfig,
  model: ArkVideoModel,
  request: Pick<EstimateRequest, "seconds" | "resolution">
): number {
  const clip = checkClip(model, request);
  return costUsd(config, model, estimateTokens(clip.resolution, clip.seconds), false);
}
