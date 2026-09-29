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
