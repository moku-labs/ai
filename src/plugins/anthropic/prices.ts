/**
 * @file anthropic prices — the bundled table (USD per 1M tokens by native
 * model id), the merge with `config.priceOverrides`, and the cost of one
 * request from its token counts: uncached input, 5-minute and 1-hour cache
 * writes, cache reads and output, with the long-context tier.
 */
import { badRequest } from "./client";
import type { AnthropicContext, AnthropicPrice, AnthropicPriceTable } from "./types";

/**
 * The tokens of one request, split by how each is priced.
 *
 * @example
 * ```ts
 * const counts: TokenCounts = { uncachedInput: 200, cacheWrite5m: 1800, cacheWrite1h: 0, cacheRead: 0, output: 80 };
 * ```
 */
export type TokenCounts = {
  /** Input tokens neither read from nor written to the cache. */
  uncachedInput: number;
  /** Input tokens written to the 5-minute cache. */
  cacheWrite5m: number;
  /** Input tokens written to the 1-hour cache. */
  cacheWrite1h: number;
  /** Input tokens read from the cache. */
  cacheRead: number;
  /** Output tokens, thinking included. */
  output: number;
};

/**
 * Bundled prices by native model id; `config.priceOverrides` merges over
 * them field by field.
 *
 * @example
 * ```ts
 * bundledPrices["claude-sonnet-5"]?.outputPerM; // => 10
 * ```
 */
export const bundledPrices: Readonly<Record<string, AnthropicPrice>> = {
  "claude-opus-5-5": {
    inputPerM: 4,
    outputPerM: 20,
    cacheReadPerM: 0.2,
    cacheWrite5mPerM: 5,
    cacheWrite1hPerM: 8
  },
  "claude-sonnet-5-5": {
    inputPerM: 2,
    outputPerM: 10,
    cacheReadPerM: 0.2,
    cacheWrite5mPerM: 2.5,
    cacheWrite1hPerM: 4
  },
  "claude-sonnet-5": {
    inputPerM: 2,
    outputPerM: 10,
    cacheReadPerM: 0.2,
    cacheWrite5mPerM: 2.5,
    cacheWrite1hPerM: 4
  },
  "claude-haiku-5-5": {
    inputPerM: 0.1,
    outputPerM: 0.5,
    cacheReadPerM: 0.01,
    cacheWrite5mPerM: 0.125,
    cacheWrite1hPerM: 0.2,
    longContext: { aboveInputTokens: 100_000, inputMultiplier: 5, outputMultiplier: 5 }
  },
  "claude-fable-5-1": {
    inputPerM: 10,
    outputPerM: 50,
    cacheReadPerM: 0.25,
    cacheWrite5mPerM: 12.5,
    cacheWrite1hPerM: 20
  }
};

/** Prices are quoted per one million tokens. */
const TOKENS_PER_PRICE_UNIT = 1_000_000;

/** Cost precision: micro-dollars. */
const MICRO_DOLLARS = 1_000_000;

/** Rates of a request below the long-context threshold. */
const BASE_RATES = { inputMultiplier: 1, outputMultiplier: 1 };

/**
 * A complete price from a merged entry, or undefined when a rate is missing.
 *
 * @param entry - A bundled row merged with its override.
 * @returns The price, or undefined.
 * @example
 * ```ts
 * completePrice({ inputPerM: 1, outputPerM: 2 }); // => undefined
 * ```
 */
function completePrice(entry: Partial<AnthropicPrice>): AnthropicPrice | undefined {
  const { inputPerM, outputPerM, cacheReadPerM, cacheWrite5mPerM, cacheWrite1hPerM } = entry;
  const isComplete =
    inputPerM !== undefined &&
    outputPerM !== undefined &&
    cacheReadPerM !== undefined &&
    cacheWrite5mPerM !== undefined &&
    cacheWrite1hPerM !== undefined;
  if (!isComplete) return undefined;

  const price = { inputPerM, outputPerM, cacheReadPerM, cacheWrite5mPerM, cacheWrite1hPerM };
  return entry.longContext === undefined ? price : { ...price, longContext: entry.longContext };
}

/**
 * The effective price table of `ctx`: the bundled table with every
 * override merged over its row field by field; a model whose merged row is
 * incomplete has no price. Computed once and kept on `ctx.state.prices`.
 *
 * @param ctx - The anthropic plugin context.
 * @returns The price table.
 */
export function getPrices(ctx: AnthropicContext): AnthropicPriceTable {
  if (ctx.state.prices !== null) return ctx.state.prices;

  const table = new Map(Object.entries(bundledPrices));
  for (const [model, override] of Object.entries(ctx.config.priceOverrides)) {
    const price = completePrice({ ...table.get(model), ...override });
    if (price === undefined) table.delete(model);
    else table.set(model, price);
  }
  ctx.state.prices = table;
  return table;
}

/**
 * The price of a model.
 *
 * @param prices - The effective price table.
 * @param model - Native model id.
 * @returns The price.
 * @throws {TerminalProviderError} A 400 when the model has no price.
 * @example
 * ```ts
 * priceOf(new Map(), "claude-next-6"); // throws: [ai] Anthropic model "claude-next-6" has no price.
 * ```
 */
export function priceOf(prices: AnthropicPriceTable, model: string): AnthropicPrice {
  const price = prices.get(model);
  if (price !== undefined) return price;
  throw badRequest(
    `[ai] Anthropic model "${model}" has no price.\n  Add it to config.priceOverrides with inputPerM, outputPerM, cacheReadPerM, cacheWrite5mPerM and cacheWrite1hPerM.`
  );
}

/**
 * The multipliers of a request: the long-context ones when its total input
 * (uncached, written and read) passes the model's threshold, else 1.
 *
 * @param price - The model's price.
 * @param tokens - The request's token counts.
 * @returns Input-side and output multipliers.
 * @example
 * ```ts
 * ratesOf({ inputPerM: 1, outputPerM: 1, cacheReadPerM: 1, cacheWrite5mPerM: 1, cacheWrite1hPerM: 1 }, { uncachedInput: 9, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 }); // => { inputMultiplier: 1, outputMultiplier: 1 }
 * ```
 */
function ratesOf(
  price: AnthropicPrice,
  tokens: TokenCounts
): { inputMultiplier: number; outputMultiplier: number } {
  const { longContext } = price;
  if (longContext === undefined) return BASE_RATES;

  const totalInput =
    tokens.uncachedInput + tokens.cacheWrite5m + tokens.cacheWrite1h + tokens.cacheRead;
  return totalInput > longContext.aboveInputTokens ? longContext : BASE_RATES;
}

/**
 * USD of one request: each kind of token at its own rate, the long-context
 * multipliers applied to the whole request above the threshold, rounded to
 * micro-dollars.
 *
 * @param price - The model's price.
 * @param tokens - The request's token counts.
 * @returns USD.
 * @example
 * ```ts
 * costUsd({ inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWrite5mPerM: 5, cacheWrite1hPerM: 8 }, { uncachedInput: 1000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 500 }); // => 0.014
 * ```
 */
export function costUsd(price: AnthropicPrice, tokens: TokenCounts): number {
  const { inputMultiplier, outputMultiplier } = ratesOf(price, tokens);

  // Input side: uncached, the two cache-write lifetimes, cache reads.
  const input =
    tokens.uncachedInput * price.inputPerM +
    tokens.cacheWrite5m * price.cacheWrite5mPerM +
    tokens.cacheWrite1h * price.cacheWrite1hPerM +
    tokens.cacheRead * price.cacheReadPerM;
  const output = tokens.output * price.outputPerM;

  const usd = (input * inputMultiplier + output * outputMultiplier) / TOKENS_PER_PRICE_UNIT;
  return Math.round(usd * MICRO_DOLLARS) / MICRO_DOLLARS;
}
