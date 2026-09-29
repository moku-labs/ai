/**
 * @file apimodels bundled price table — data module (USD per second of video,
 * key `alias@resolution`, plus `asset`: USD per asset registration), and the
 * lookups estimate and actual cost share. A key without a price throws: a
 * paid job never runs at an unknown price.
 */
import type { EstimateRequest } from "../video/contract";
import { TerminalProviderError } from "./errors";
import { BAD_REQUEST } from "./http";
import type { ApimodelsContext } from "./types";
import { requestResolution, requestSeconds, resolveModel } from "./video/models";

/**
 * Bundled prices from the apimodels model pages (checked 2026-09-29): USD
 * per second keyed `<alias>@<resolution>`, and `asset`, USD per successful
 * asset registration. Override any key via `config.priceOverrides`.
 *
 * @example
 * ```ts
 * bundledPrices["seedance-2.5@720p"]; // => 0.27
 * ```
 */
export const bundledPrices: Readonly<Record<string, number>> = {
  "seedance-2.5@480p": 0.12,
  "seedance-2.5@720p": 0.27,
  "seedance-2.5-ref@480p": 0.12,
  "seedance-2.5-ref@720p": 0.27,
  "seedance-2.0@480p": 0.092,
  "seedance-2.0@720p": 0.197,
  "seedance-2.0@1080p": 0.492,
  "seedance-2.0-ref@480p": 0.092,
  "seedance-2.0-ref@720p": 0.197,
  "seedance-2.0-ref@1080p": 0.492,
  asset: 0.01
};

/** Price key of one asset registration. */
const ASSET_PRICE_KEY = "asset";

/** Cost precision: results are rounded to micro-dollars so 0.1 + 0.2 is 0.3. */
const MICRO_DOLLARS = 1_000_000;

/**
 * Merges the bundled table with config overrides (an override replaces its key).
 *
 * @param overrides - `config.priceOverrides`.
 * @returns The effective price table.
 * @example
 * ```ts
 * mergePrices({ asset: 0.02 }).asset; // => 0.02
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
 */
export function resolvePrices(ctx: ApimodelsContext): Record<string, number> {
  if (ctx.state.prices === null) {
    ctx.state.prices = mergePrices(ctx.config.priceOverrides);
  }
  return ctx.state.prices;
}

/**
 * Finds the USD-per-second price of an alias at a resolution.
 *
 * @param prices - The effective price table.
 * @param alias - The model alias.
 * @param resolution - The effective resolution.
 * @returns USD per second.
 * @throws {TerminalProviderError} A 400 naming the key to add to priceOverrides.
 * @example
 * ```ts
 * lookupPerSecond(bundledPrices, "seedance-2.0", "1080p"); // => 0.492
 * ```
 */
export function lookupPerSecond(
  prices: Readonly<Record<string, number>>,
  alias: string,
  resolution: string
): number {
  const key = `${alias}@${resolution}`;
  const price = prices[key];
  if (price === undefined) {
    throw new TerminalProviderError(
      `[ai] No price for apimodels model "${alias}" at ${resolution}.\n  Add "${key}" to apimodels priceOverrides.`,
      BAD_REQUEST
    );
  }
  return price;
}

/**
 * Rounds a cost to micro-dollars.
 *
 * @param usd - Cost in USD.
 * @returns The rounded cost.
 * @example
 * ```ts
 * roundUsd(0.1 + 0.2); // => 0.3
 * ```
 */
export function roundUsd(usd: number): number {
  return Math.round(usd * MICRO_DOLLARS) / MICRO_DOLLARS;
}

/**
 * Table cost of a video request: seconds × USD per second of its alias and
 * resolution. Estimate and the done fallback both come from here.
 *
 * @param ctx - Plugin context (effective price table).
 * @param request - The video request, resolved or not.
 * @returns Cost in USD, rounded to micro-dollars.
 * @throws {TerminalProviderError} For an unknown alias or a key without a price.
 */
export function videoCostUsd(ctx: ApimodelsContext, request: EstimateRequest): number {
  const model = resolveModel(request.model);
  const perSecond = lookupPerSecond(
    resolvePrices(ctx),
    model.alias,
    requestResolution(model, request)
  );
  return roundUsd(requestSeconds(request) * perSecond);
}

/**
 * USD of one asset registration (`asset` in the effective table).
 *
 * @param ctx - Plugin context (effective price table).
 * @returns USD per registration.
 * @throws {TerminalProviderError} When the table has no `asset` price.
 */
export function assetPriceUsd(ctx: ApimodelsContext): number {
  const price = resolvePrices(ctx)[ASSET_PRICE_KEY];
  if (price === undefined) {
    throw new TerminalProviderError(
      '[ai] No price for apimodels asset registration.\n  Add "asset" to apimodels priceOverrides.',
      BAD_REQUEST
    );
  }
  return price;
}
