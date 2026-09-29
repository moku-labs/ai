/**
 * @file fal price table — merge and prefix only. The tables live in the task
 * directories (`video/prices.ts`, `image/prices.ts`, `llm/prices.ts`,
 * `music/prices.ts`); this module merges them into the one table every task
 * reads, with `config.priceOverrides` last. Video keys stay unprefixed; the
 * other tasks' keys carry `image:`, `music:` or `llm:`. The merge runs at call
 * time, never at module load, so the import cycle with `video/prices.ts` is safe.
 */
import { imagePrices } from "./image/prices";
import { llmPriceRows } from "./llm/prices";
import { musicPrices } from "./music/prices";
import type { FalContext, FalTask } from "./types";
import { TerminalProviderError } from "./types";
import { videoPrices } from "./video/prices";

/** Status of a request refused before any charge. */
const BAD_REQUEST = 400;

/**
 * Prefixes every key of a price table with `<prefix>:`.
 *
 * @param prefix - The task prefix, e.g. "image".
 * @param table - Prices keyed by alias (and resolution).
 * @returns A new table with prefixed keys.
 * @example
 * ```ts
 * prefixKeys("music", { "stable-audio-2.5": 0.2 }); // => { "music:stable-audio-2.5": 0.2 }
 * ```
 */
export function prefixKeys(
  prefix: string,
  table: Readonly<Record<string, number>>
): Record<string, number> {
  const entries = Object.entries(table).map(([key, usd]) => [`${prefix}:${key}`, usd]);
  return Object.fromEntries(entries);
}

/**
 * Merges every task's bundled table with config overrides (overrides win).
 *
 * @param overrides - `config.priceOverrides`.
 * @returns The effective price table of all four tasks.
 * @example
 * ```ts
 * mergePrices({ "image:gpt-image-2.5": 0.07 })["image:gpt-image-2.5"]; // => 0.07
 * mergePrices({})["llm:anthropic/claude-opus-5.5#out"]; // => 20
 * ```
 */
export function mergePrices(overrides: Record<string, number>): Record<string, number> {
  return {
    ...videoPrices,
    ...prefixKeys("image", imagePrices),
    ...prefixKeys("music", musicPrices),
    ...llmPriceRows(),
    ...overrides
  };
}

/**
 * Resolves the effective price table, computing and caching it into
 * `ctx.state.prices` on first use.
 *
 * @param ctx - Plugin context (`config.priceOverrides`, `state.prices`).
 * @returns The effective price table.
 */
export function resolvePrices(ctx: FalContext): Record<string, number> {
  if (ctx.state.prices === null) {
    ctx.state.prices = mergePrices(ctx.config.priceOverrides);
  }
  return ctx.state.prices;
}

/**
 * The error for a model without a price: a paid job never runs at an unknown
 * price (D13). Terminal, before any upload or charge.
 *
 * @param task - The task whose table has no row.
 * @param id - The model alias or id.
 * @returns The error to throw.
 * @example
 * ```ts
 * missingPriceError("music", "x").message; // => '[ai] No price for fal music model "x".\n  Add it to fal.priceOverrides.'
 * ```
 */
export function missingPriceError(
  task: Exclude<FalTask, "video">,
  id: string
): TerminalProviderError {
  return new TerminalProviderError(
    `[ai] No price for fal ${task} model "${id}".\n  Add it to fal.priceOverrides.`,
    BAD_REQUEST
  );
}
