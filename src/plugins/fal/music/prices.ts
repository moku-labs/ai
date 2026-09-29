/**
 * @file fal music prices — USD per started minute or per generation; root adds `music:`.
 */
import { missingPriceError } from "../prices";
import type { MusicBilling } from "./models";

/** Milliseconds in a billed minute. */
const MS_PER_MINUTE = 60_000;

/** Cost precision: micro-dollars. */
const MICRO_DOLLARS = 1_000_000;

/**
 * Bundled prices by alias: USD per started minute for ElevenLabs, USD per
 * generation for Stable Audio. Override with `music:<alias>` in `config.priceOverrides`.
 *
 * @example
 * ```ts
 * musicPrices["elevenlabs-music-v2.5"]; // => 0.8
 * ```
 */
export const musicPrices: Readonly<Record<string, number>> = {};

/**
 * The unit price of a music model: `music:<alias>` from the merged table.
 *
 * @param prices - The merged price table (prefixed keys).
 * @param alias - The music model alias.
 * @returns USD per billing unit.
 * @throws {TerminalProviderError} When the table has no row.
 * @example
 * ```ts
 * musicRate({ "music:stable-audio-2.5": 0.2 }, "stable-audio-2.5"); // => 0.2
 * ```
 */
export function musicRate(prices: Readonly<Record<string, number>>, alias: string): number {
  const price = prices[`music:${alias}`];
  if (price === undefined) throw missingPriceError("music", alias);
  return price;
}

/**
 * USD for one track: per started minute, or per generation.
 *
 * @param prices - The merged price table (prefixed keys).
 * @param alias - The music model alias.
 * @param billing - How the model is billed.
 * @param lengthMs - Track length, ms.
 * @returns USD, rounded to micro-dollars.
 * @throws {TerminalProviderError} When the table has no row.
 * @example
 * ```ts
 * musicPriceOf({ "music:elevenlabs-music-v2.5": 0.8 }, "elevenlabs-music-v2.5", "minute", 65_000); // => 1.6
 * ```
 */
export function musicPriceOf(
  prices: Readonly<Record<string, number>>,
  alias: string,
  billing: MusicBilling,
  lengthMs: number
): number {
  const rate = musicRate(prices, alias);
  if (billing === "generation") return rate;

  const minutes = Math.ceil(lengthMs / MS_PER_MINUTE);
  return Math.round(rate * minutes * MICRO_DOLLARS) / MICRO_DOLLARS;
}
