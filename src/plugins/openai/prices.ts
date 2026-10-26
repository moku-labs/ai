/**
 * @file openai bundled price table — data module (USD per M tokens / M
 * characters by model) + shared cost math: chat and tts cost, and the
 * cache-aware cost of a prompt-gen answer.
 */
import type { ModelPrice, OpenaiContext, PriceTable } from "./types";

/**
 * Token counts of one request, split by how each is priced.
 *
 * @example
 * ```ts
 * const tokens: TokenSplit = { uncached: 600, cacheReads: 1800, cacheWrites30m: 0, cacheWrites12h: 0, output: 120 };
 * ```
 */
export type TokenSplit = {
  /** Input tokens neither read from nor written to the cache. */
  uncached: number;
  /** Input tokens read from the cache. */
  cacheReads: number;
  /** Input tokens written to the cache for 30 minutes. */
  cacheWrites30m: number;
  /** Input tokens written to the cache for 12 hours. */
  cacheWrites12h: number;
  /** Output tokens. */
  output: number;
};

/**
 * Multipliers on a model's rates: 1 and 1 in the standard tier.
 *
 * @example
 * ```ts
 * const longContext: PriceTier = { input: 2, output: 1.5 };
 * ```
 */
export type PriceTier = {
  /** Multiplier on every input-side rate (input, cache read, cache writes). */
  input: number;
  /** Multiplier on the output rate. */
  output: number;
};

/** Characters-per-token heuristic used for the token-count estimate (fast, dependency-free — not a real tokenizer). */
const HEURISTIC_CHARS_PER_TOKEN = 4;

/** Prices in the bundled/override tables are quoted per one million tokens or characters. */
const PER_MILLION = 1_000_000;

/** Bundled prices by model; merged with `config.priceOverrides` at first use. */
export const bundledPrices: PriceTable = {
  "gpt-4o-mini-tts": { ttsPerMChars: 15 },
  "tts-1": { ttsPerMChars: 15 },
  "tts-1-hd": { ttsPerMChars: 30 },
  "gpt-4o-mini": { inputPerM: 0.15, cachedInputPerM: 0.075, outputPerM: 0.6 },
  "gpt-4o": { inputPerM: 2.5, cachedInputPerM: 1.25, outputPerM: 10 },
  "gpt-6-astra": {
    inputPerM: 10,
    cachedInputPerM: 1,
    cacheWritePerM: 12.5,
    cacheWrite12hPerM: 25,
    outputPerM: 50
  },
  "gpt-6.1-sol": {
    inputPerM: 2,
    cachedInputPerM: 0.1,
    cacheWritePerM: 2.5,
    cacheWrite12hPerM: 5,
    outputPerM: 10
  },
  "gpt-6-sol": {
    inputPerM: 2,
    cachedInputPerM: 0.2,
    cacheWritePerM: 2.5,
    cacheWrite12hPerM: 5,
    outputPerM: 10
  },
  "gpt-6-luna": {
    inputPerM: 0.1,
    cachedInputPerM: 0.01,
    cacheWritePerM: 0.125,
    cacheWrite12hPerM: 0.25,
    outputPerM: 0.5
  }
};

/**
 * Resolves the effective price table for `ctx`: the bundled table merged
 * with `config.priceOverrides` (an override replaces its model's whole
 * entry field-by-field), computed once and cached on `ctx.state.prices`.
 *
 * @param ctx - The openai plugin context.
 * @returns The effective price table.
 * @example
 * ```ts
 * const prices = getPrices(ctx);
 * ```
 */
export function getPrices(ctx: OpenaiContext): PriceTable {
  if (ctx.state.prices !== null) return ctx.state.prices;
  const merged: PriceTable = { ...bundledPrices };
  for (const [model, override] of Object.entries(ctx.config.priceOverrides)) {
    merged[model] = { ...merged[model], ...override };
  }
  ctx.state.prices = merged;
  return merged;
}

/**
 * Estimates a token count from a character count using a fixed
 * chars-per-token heuristic (~4 characters per token for English text) — a
 * fast, dependency-free approximation, not a real tokenizer.
 *
 * @param text - The text to estimate.
 * @returns The estimated token count.
 * @example
 * ```ts
 * estimateTokenCount("Hello, world!"); // => 4
 * ```
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / HEURISTIC_CHARS_PER_TOKEN);
}

/**
 * Computes a chat-based cost from input/output token counts and a model's
 * per-million-token prices. A model missing from `prices` prices as free
 * (0 USD) — an unpriced/custom model should be added via `config.priceOverrides`.
 *
 * @param prices - The effective price table.
 * @param model - The chat model used.
 * @param inputTokens - Input (prompt) token count.
 * @param outputTokens - Output (completion) token count.
 * @returns The cost in US dollars.
 * @example
 * ```ts
 * estimateChatCostUsd(prices, "gpt-4o-mini", 100, 50);
 * ```
 */
export function estimateChatCostUsd(
  prices: PriceTable,
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const entry = prices[model];
  const inputUsd = (inputTokens / PER_MILLION) * (entry?.inputPerM ?? 0);
  const outputUsd = (outputTokens / PER_MILLION) * (entry?.outputPerM ?? 0);
  return inputUsd + outputUsd;
}

/**
 * Computes a tts cost from a character count and a model's
 * per-million-character price. A model missing from `prices` prices as free
 * (0 USD) — an unpriced/custom model should be added via `config.priceOverrides`.
 *
 * @param prices - The effective price table.
 * @param model - The tts model used.
 * @param characters - The character count of the synthesized text.
 * @returns The cost in US dollars.
 * @example
 * ```ts
 * estimateTtsCostUsd(prices, "gpt-4o-mini-tts", 1_000);
 * ```
 */
export function estimateTtsCostUsd(prices: PriceTable, model: string, characters: number): number {
  const entry = prices[model];
  return (characters / PER_MILLION) * (entry?.ttsPerMChars ?? 0);
}

/**
 * Computes the cost of one prompt-gen request from its token split: uncached
 * input at `inputPerM`, cache reads at `cachedInputPerM`, 30-minute writes at
 * `cacheWritePerM`, 12-hour writes at `cacheWrite12hPerM`, output at
 * `outputPerM`, each input-side rate times `tier.input` and the output rate
 * times `tier.output`. A missing cache rate falls back to the next one up
 * (12h → 30m → input; cached → input); a model without prices costs 0 USD.
 *
 * @param entry - The model's prices, if any.
 * @param tokens - The token split.
 * @param tier - Rate multipliers (long context).
 * @returns The cost in US dollars.
 * @example
 * ```ts
 * cacheAwareCostUsd({ inputPerM: 10, cachedInputPerM: 1, outputPerM: 50 }, { uncached: 1e6, cacheReads: 1e6, cacheWrites30m: 0, cacheWrites12h: 0, output: 0 }, { input: 1, output: 1 }); // => 11
 * ```
 */
export function cacheAwareCostUsd(
  entry: Partial<ModelPrice> | undefined,
  tokens: TokenSplit,
  tier: PriceTier
): number {
  // Each rate, with the fallback to the rate above it when the table has none.
  const input = entry?.inputPerM ?? 0;
  const cachedInput = entry?.cachedInputPerM ?? input;
  const write30m = entry?.cacheWritePerM ?? input;
  const write12h = entry?.cacheWrite12hPerM ?? write30m;
  const output = entry?.outputPerM ?? 0;

  // Input side and output side, each at its tier multiplier.
  const inputUsd =
    tokens.uncached * input +
    tokens.cacheReads * cachedInput +
    tokens.cacheWrites30m * write30m +
    tokens.cacheWrites12h * write12h;
  const outputUsd = tokens.output * output;
  return (inputUsd * tier.input + outputUsd * tier.output) / PER_MILLION;
}
