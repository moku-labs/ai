/**
 * @file fal sprite prices — USD per image; root `prices.ts` adds `sprite:`.
 * `none` makes no call, so it costs 0 and has no row.
 */
import { missingPriceError } from "../prices";
import type { SpriteAlias } from "./models";

/**
 * Bundled USD per image, by matte alias. Override with `sprite:<alias>` in
 * `config.priceOverrides`.
 *
 * An estimate: fal bills BiRefNet v2 at $0.0008 per compute second and does
 * not publish a per-image figure (checked 2026-10-04). $0.002 covers about
 * 2.5 s of compute per image.
 *
 * @example
 * ```ts
 * spritePrices.birefnet; // => 0.002
 * ```
 */
export const spritePrices: Readonly<Record<string, number>> = {
  birefnet: 0.002
};

/**
 * USD for one sprite: `sprite:<alias>` from the merged table, 0 for `none`.
 *
 * @param prices - The merged price table (prefixed keys).
 * @param alias - The sprite model alias.
 * @returns USD per image.
 * @throws {TerminalProviderError} When a matte model has no row.
 * @example
 * ```ts
 * spritePriceOf({ "sprite:birefnet": 0.002 }, "birefnet"); // => 0.002
 * ```
 */
export function spritePriceOf(
  prices: Readonly<Record<string, number>>,
  alias: SpriteAlias
): number {
  if (alias === "none") return 0;

  const price = prices[`sprite:${alias}`];
  if (price === undefined) throw missingPriceError("sprite", alias);
  return price;
}
