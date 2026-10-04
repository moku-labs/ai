/**
 * @file fal sfx prices — USD per started second; root `prices.ts` adds `sfx:`.
 */
import { missingPriceError } from "../prices";

/** Milliseconds in a billed second. */
const MS_PER_SECOND = 1000;

/** Cost precision: micro-dollars. */
const MICRO_DOLLARS = 1_000_000;

/**
 * Bundled USD per started second, by alias, from the fal model page
 * (checked 2026-10-04). Override with `sfx:<alias>` in `config.priceOverrides`.
 *
 * @example
 * ```ts
 * sfxPrices["elevenlabs-sfx-v2"]; // => 0.002
 * ```
 */
export const sfxPrices: Readonly<Record<string, number>> = {
  "elevenlabs-sfx-v2": 0.002
};

/**
 * The per-second price of an sfx model: `sfx:<alias>` from the merged table.
 *
 * @param prices - The merged price table (prefixed keys).
 * @param alias - The sfx model alias.
 * @returns USD per started second.
 * @throws {TerminalProviderError} When the table has no row.
 * @example
 * ```ts
 * sfxRate({ "sfx:elevenlabs-sfx-v2": 0.002 }, "elevenlabs-sfx-v2"); // => 0.002
 * ```
 */
export function sfxRate(prices: Readonly<Record<string, number>>, alias: string): number {
  const price = prices[`sfx:${alias}`];
  if (price === undefined) throw missingPriceError("sfx", alias);
  return price;
}

/**
 * USD for one clip: the rate times the started seconds of `durationMs`.
 *
 * @param prices - The merged price table (prefixed keys).
 * @param alias - The sfx model alias.
 * @param durationMs - Clip length, ms; the caller passes the model's longest clip when the request has none.
 * @returns USD, rounded to micro-dollars.
 * @throws {TerminalProviderError} When the table has no row.
 * @example
 * ```ts
 * sfxPriceOf({ "sfx:elevenlabs-sfx-v2": 0.002 }, "elevenlabs-sfx-v2", 2500); // => 0.006
 * ```
 */
export function sfxPriceOf(
  prices: Readonly<Record<string, number>>,
  alias: string,
  durationMs: number
): number {
  const seconds = Math.ceil(durationMs / MS_PER_SECOND);
  return Math.round(sfxRate(prices, alias) * seconds * MICRO_DOLLARS) / MICRO_DOLLARS;
}
