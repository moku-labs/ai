/**
 * @file fal upscale prices — USD per second of source video; root adds `upscale:`.
 */
import { missingPriceError } from "../prices";

/** Cost precision: micro-dollars. */
const MICRO_DOLLARS = 1_000_000;

/**
 * Bundled prices by alias, USD per second of source video, at the ≤1080p / 30 fps
 * output rate (fal bills more above it). Override with `upscale:<alias>` in `config.priceOverrides`.
 *
 * @example
 * ```ts
 * upscalePrices["starlight-fast-2"]; // => 0.06
 * ```
 */
export const upscalePrices: Readonly<Record<string, number>> = {
  "starlight-fast-2": 0.06,
  "starlight-precise-2.6": 0.12,
  proteus: 0.02
};

/**
 * The per-second price of an upscale model: `upscale:<alias>` from the merged table.
 *
 * @param prices - The merged price table (prefixed keys).
 * @param alias - The upscale model alias.
 * @returns USD per second of source video.
 * @throws {TerminalProviderError} When the table has no row.
 * @example
 * ```ts
 * upscaleRate({ "upscale:proteus": 0.03 }, "proteus"); // => 0.03
 * ```
 */
export function upscaleRate(prices: Readonly<Record<string, number>>, alias: string): number {
  const price = prices[`upscale:${alias}`];
  if (price === undefined) throw missingPriceError("upscale", alias);
  return price;
}

/**
 * USD for one video: the per-second rate times the source length.
 *
 * @param prices - The merged price table (prefixed keys).
 * @param alias - The upscale model alias.
 * @param seconds - Source length, seconds.
 * @returns USD, rounded to micro-dollars.
 * @throws {TerminalProviderError} When the table has no row.
 * @example
 * ```ts
 * upscalePriceOf({ "upscale:starlight-fast-2": 0.06 }, "starlight-fast-2", 62.4); // => 3.744
 * ```
 */
export function upscalePriceOf(
  prices: Readonly<Record<string, number>>,
  alias: string,
  seconds: number
): number {
  const rate = upscaleRate(prices, alias);
  return Math.round(rate * seconds * MICRO_DOLLARS) / MICRO_DOLLARS;
}
