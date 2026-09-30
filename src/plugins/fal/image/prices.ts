/**
 * @file fal image prices — USD per image; root `prices.ts` adds the `image:` prefix.
 */
import { missingPriceError } from "../prices";

/**
 * Bundled USD-per-image prices by `<alias>` or `<alias>@<resolution>`, from the
 * fal model pages. Override with `image:<key>` in `config.priceOverrides`.
 *
 * @example
 * ```ts
 * imagePrices["nano-banana-pro@4K"]; // => 0.3
 * ```
 */
export const imagePrices: Readonly<Record<string, number>> = {
  "nano-banana-pro@1K": 0.15,
  "nano-banana-pro@2K": 0.15,
  "nano-banana-pro@4K": 0.3,
  "seedream-4.5-edit": 0.04,
  "gpt-image-2.5": 0.05,
  // Not listed by fal: its high-quality token table interpolated to 2048x2048 (the largest 2K size).
  "gpt-image-2.5@2K": 0.06
};

/**
 * GPT Image price factor by quality, over the bundled `high` price. fal's
 * table (2026-09-30) is the same ratio at every size: xhigh ≈ 1.78 × high,
 * max = 4 × high. Lower qualities keep the `high` price, an upper bound.
 *
 * @example
 * ```ts
 * GPT_QUALITY_FACTORS.max; // => 4
 * ```
 */
export const GPT_QUALITY_FACTORS: Readonly<Record<string, number>> = { xhigh: 1.78, max: 4 };

/** The alias whose price scales by `params.quality`. */
const GPT_ALIAS = "gpt-image-2.5";

/**
 * Price factor of `params.quality` for a model: {@link GPT_QUALITY_FACTORS}
 * for GPT Image, else 1.
 *
 * @param alias - The image model alias.
 * @param quality - `params.quality` when it is a string.
 * @returns The factor applied to the table price.
 * @example
 * ```ts
 * imageQualityFactor("gpt-image-2.5", "xhigh"); // => 1.78
 * ```
 */
export function imageQualityFactor(alias: string, quality: string | undefined): number {
  if (alias !== GPT_ALIAS || quality === undefined) return 1;
  return GPT_QUALITY_FACTORS[quality] ?? 1;
}

/**
 * USD for one image: `image:<alias>@<resolution>` when a resolution is
 * planned, then `image:<alias>`.
 *
 * @param prices - The merged price table (prefixed keys).
 * @param alias - The image model alias.
 * @param resolution - The planned resolution, if any.
 * @returns USD per image.
 * @throws {TerminalProviderError} When no key matches.
 * @example
 * ```ts
 * imagePriceOf({ "image:gpt-image-2.5": 0.05 }, "gpt-image-2.5", "2K"); // => 0.05 (no @2K row in this table)
 * ```
 */
export function imagePriceOf(
  prices: Readonly<Record<string, number>>,
  alias: string,
  resolution: string | undefined
): number {
  const keys = resolution === undefined ? [alias] : [`${alias}@${resolution}`, alias];
  for (const key of keys) {
    const price = prices[`image:${key}`];
    if (price !== undefined) return price;
  }
  throw missingPriceError("image", alias);
}
