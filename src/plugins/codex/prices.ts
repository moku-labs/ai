/**
 * @file codex bundled price table — USD per image by model. Codex runs on
 * the user's ChatGPT plan, so the marginal price is an explicit 0. A model
 * missing from the table is an error, never a silent 0 (D13).
 */
import type { CodexContext } from "./types";

/**
 * Bundled per-image prices by model, in USD. Plan-billed, so explicit zeros.
 */
export const bundledPrices: Record<string, number> = {
  "gpt-6-astra": 0
};

/**
 * Merges the bundled price table with config overrides (overrides win).
 *
 * @param overrides - Per-model price overrides from `config.priceOverrides`.
 * @returns The effective price table.
 * @example
 * ```ts
 * mergePrices({ "gpt-6-astra": 0.01 });
 * ```
 */
export function mergePrices(overrides: Record<string, number>): Record<string, number> {
  return { ...bundledPrices, ...overrides };
}

/**
 * Resolves the effective price table, computing and caching it into
 * `ctx.state.prices` on first use.
 *
 * @param ctx - Plugin context exposing `config.priceOverrides` and `state.prices`.
 * @returns The effective price table.
 * @example
 * ```ts
 * const prices = resolvePrices(ctx);
 * ```
 */
export function resolvePrices(ctx: CodexContext): Record<string, number> {
  if (ctx.state.prices === null) {
    ctx.state.prices = mergePrices(ctx.config.priceOverrides);
  }
  return ctx.state.prices;
}

/**
 * Price of one image on `model`.
 *
 * @param ctx - Plugin context (for the effective price table).
 * @param model - Codex model id.
 * @returns USD per image.
 * @throws {Error} When the model has no price.
 * @example
 * ```ts
 * priceOf(ctx, "gpt-6-astra"); // => 0
 * ```
 */
export function priceOf(ctx: CodexContext, model: string): number {
  const price = resolvePrices(ctx)[model];
  if (price === undefined) {
    throw new Error(`[ai] No price for codex model "${model}".\n  Add it to codex priceOverrides.`);
  }
  return price;
}
