/**
 * @file fal bundled price table — data module (USD per second of video), plus
 * the one lookup that estimate and actual cost share. An alias or resolution
 * without a price throws: a paid job never runs at an unknown price (D13).
 */
import type { VideoRequest } from "../video/contract";
import { modelAudio, modelResolution, requestSeconds, resolveFalModel } from "./models";
import type { FalContext } from "./types";

/**
 * Bundled USD-per-second prices from the fal model pages. Keys are
 * `<alias>@<resolution>`, `<alias>+audio` or `<alias>`. Override via
 * `config.priceOverrides`.
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
 * Cost of a video request: seconds x USD per second of its model variant.
 * Estimate and actual cost both come from here.
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
  const perSecond = lookupPrice(
    resolvePrices(ctx),
    model.alias,
    modelResolution(model, request),
    modelAudio(model, request)
  );
  return Math.round(requestSeconds(request) * perSecond * MICRO_DOLLARS) / MICRO_DOLLARS;
}
