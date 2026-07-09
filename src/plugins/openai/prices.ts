/**
 * @file openai bundled price table — data module (USD per M tokens / M
 * characters by model) + shared cost-estimation math used by all three handlers.
 */
import type { OpenaiContext, PriceTable } from "./types";

/** Characters-per-token heuristic used for the token-count estimate (fast, dependency-free — not a real tokenizer). */
const HEURISTIC_CHARS_PER_TOKEN = 4;

/** Prices in the bundled/override tables are quoted per one million tokens or characters. */
const PER_MILLION = 1_000_000;

/** Bundled prices by model; merged with `config.priceOverrides` at first use. */
export const bundledPrices: PriceTable = {
  "gpt-4o-mini-tts": { ttsPerMChars: 15 },
  "tts-1": { ttsPerMChars: 15 },
  "tts-1-hd": { ttsPerMChars: 30 },
  "gpt-4o-mini": { inputPerM: 0.15, outputPerM: 0.6 },
  "gpt-4o": { inputPerM: 2.5, outputPerM: 10 }
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
