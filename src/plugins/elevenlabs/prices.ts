/**
 * @file elevenlabs bundled price table — data module (USD per character by
 * model). Approximate defaults derived from ElevenLabs' published
 * per-character pricing tiers; override precisely via `config.priceOverrides`.
 */
import type { ElevenlabsContext } from "./types";

/**
 * Bundled per-character prices by model, in USD. Approximate defaults —
 * override via `config.priceOverrides` for exact per-account pricing.
 */
export const bundledPrices: Record<string, number> = {
  eleven_multilingual_v2: 0.0003,
  eleven_turbo_v2_5: 0.000_15,
  eleven_flash_v2_5: 0.000_06,
  eleven_monolingual_v1: 0.0003
};

/**
 * Merges the bundled price table with config-supplied overrides (overrides
 * win on key conflicts — the standard shallow-merge precedence, spec/03).
 *
 * @param overrides - Per-model price overrides from `config.priceOverrides`.
 * @returns The effective price table.
 * @example
 * ```ts
 * mergePrices({ eleven_multilingual_v2: 0.0005 });
 * ```
 */
export function mergePrices(overrides: Record<string, number>): Record<string, number> {
  return { ...bundledPrices, ...overrides };
}

/**
 * Resolves the effective price table, computing and caching it into
 * `ctx.state.prices` on first use (spec/10 — "computed once at first use").
 * Shared by `api.ts` (`info()`) and `voiceover/handler.ts`
 * (`estimate()`/`execute()`) so both coordinate through root state rather
 * than importing each other.
 *
 * @param ctx - Plugin context exposing `config.priceOverrides` and the mutable `state.prices` cache.
 * @returns The effective price table.
 * @example
 * ```ts
 * const prices = resolvePrices(ctx);
 * ```
 */
export function resolvePrices(ctx: ElevenlabsContext): Record<string, number> {
  if (ctx.state.prices === null) {
    ctx.state.prices = mergePrices(ctx.config.priceOverrides);
  }
  return ctx.state.prices;
}
