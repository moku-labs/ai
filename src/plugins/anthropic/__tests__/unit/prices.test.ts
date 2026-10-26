/**
 * @file anthropic prices — the bundled rows through the cost they price,
 * cache reads and writes, the Haiku long-context tier, micro-dollar
 * rounding, and the override merge.
 */
import { describe, expect, it } from "vitest";
import { TerminalProviderError } from "../../errors";
import type { TokenCounts } from "../../prices";
import { costUsd, getPrices, priceOf } from "../../prices";
import { createFakeAnthropicContext } from "./fixtures";

const NONE: TokenCounts = {
  uncachedInput: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  output: 0
};
/** At most Haiku's long-context threshold, so every model prices at its base rates. */
const TOKENS = 100_000;

/**
 * The bundled price of `model`.
 *
 * @param model - Native model id.
 * @returns The price.
 */
function bundled(model: string) {
  return priceOf(getPrices(createFakeAnthropicContext()), model);
}

describe("anthropic prices: bundled table", () => {
  it.each([
    ["claude-opus-5-5", [4, 20, 0.2, 5, 8]],
    ["claude-sonnet-5-5", [2, 10, 0.2, 2.5, 4]],
    ["claude-sonnet-5", [2, 10, 0.2, 2.5, 4]],
    ["claude-haiku-5-5", [0.1, 0.5, 0.01, 0.125, 0.2]],
    ["claude-fable-5-1", [10, 50, 0.25, 12.5, 20]]
  ])("prices 100 000 tokens of each kind on %s at in, out, read, write 5m, write 1h = %o per 1M", (model, rates) => {
    const price = bundled(model);

    const costs = [
      costUsd(price, { ...NONE, uncachedInput: TOKENS }),
      costUsd(price, { ...NONE, output: TOKENS }),
      costUsd(price, { ...NONE, cacheRead: TOKENS }),
      costUsd(price, { ...NONE, cacheWrite5m: TOKENS }),
      costUsd(price, { ...NONE, cacheWrite1h: TOKENS })
    ];

    expect(costs).toEqual(rates.map(rate => rate / 10));
  });

  it("refuses a model with no price, naming it and the override to add", () => {
    const prices = getPrices(createFakeAnthropicContext());

    expect(() => priceOf(prices, "claude-next-6")).toThrow(TerminalProviderError);
    expect(() => priceOf(prices, "claude-next-6")).toThrow(
      '[ai] Anthropic model "claude-next-6" has no price.\n  Add it to config.priceOverrides with inputPerM, outputPerM, cacheReadPerM, cacheWrite5mPerM and cacheWrite1hPerM.'
    );
  });

  it("does not take an inherited object key for a price", () => {
    const prices = getPrices(createFakeAnthropicContext());

    expect(() => priceOf(prices, "constructor")).toThrow(TerminalProviderError);
  });
});

describe("anthropic prices: cost of one request", () => {
  it("adds uncached input, 5m and 1h writes, reads and output at their own rates", () => {
    const usd = costUsd(bundled("claude-opus-5-5"), {
      uncachedInput: 1000,
      cacheWrite5m: 300,
      cacheWrite1h: 100,
      cacheRead: 2000,
      output: 500
    });

    // 1000×4 + 300×5 + 100×8 + 2000×0.2 + 500×20, per million
    expect(usd).toBe(0.0167);
  });

  it("keeps the base rates at exactly the long-context threshold", () => {
    const usd = costUsd(bundled("claude-haiku-5-5"), {
      ...NONE,
      uncachedInput: 50_000,
      cacheRead: 50_000,
      output: 10_000
    });

    // 50 000×0.1 + 50 000×0.01 + 10 000×0.5, per million
    expect(usd).toBe(0.0105);
  });

  it("multiplies every rate of a Haiku request whose total input passes 100 000", () => {
    const usd = costUsd(bundled("claude-haiku-5-5"), {
      ...NONE,
      uncachedInput: 50_000,
      cacheRead: 50_001,
      output: 10_000
    });

    // (50 000×0.1 + 50 001×0.01) × 5 + 10 000×0.5 × 5 = 52 500.05, per million, to micro-dollars
    expect(usd).toBe(0.0525);
  });

  it("counts cache writes in the long-context total", () => {
    const base = { ...NONE, uncachedInput: 60_000, output: 0 };

    const below = costUsd(bundled("claude-haiku-5-5"), { ...base, cacheWrite1h: 40_000 });
    const above = costUsd(bundled("claude-haiku-5-5"), { ...base, cacheWrite1h: 40_001 });

    expect(below).toBe(0.014);
    expect(above).toBeCloseTo(0.070_001, 6);
  });

  it("rounds to micro-dollars", () => {
    const usd = costUsd(bundled("claude-haiku-5-5"), { ...NONE, uncachedInput: 1 });

    expect(usd).toBe(0);
  });
});

describe("anthropic prices: overrides", () => {
  it("merges an override field by field over the bundled row", () => {
    const ctx = createFakeAnthropicContext({
      config: { priceOverrides: { "claude-opus-5-5": { inputPerM: 3 } } }
    });

    const price = priceOf(getPrices(ctx), "claude-opus-5-5");

    expect(price).toEqual({
      inputPerM: 3,
      outputPerM: 20,
      cacheReadPerM: 0.2,
      cacheWrite5mPerM: 5,
      cacheWrite1hPerM: 8
    });
  });

  it("adds a model with a complete override, long-context tier included", () => {
    const longContext = { aboveInputTokens: 10, inputMultiplier: 2, outputMultiplier: 3 };
    const full = {
      inputPerM: 1,
      outputPerM: 2,
      cacheReadPerM: 0.1,
      cacheWrite5mPerM: 1.25,
      cacheWrite1hPerM: 2,
      longContext
    };
    const ctx = createFakeAnthropicContext({
      config: { priceOverrides: { "claude-next-6": full } }
    });

    expect(priceOf(getPrices(ctx), "claude-next-6")).toEqual(full);
  });

  it("leaves a model with an incomplete override unpriced", () => {
    const ctx = createFakeAnthropicContext({
      config: { priceOverrides: { "claude-next-6": { inputPerM: 1, outputPerM: 2 } } }
    });

    expect(() => priceOf(getPrices(ctx), "claude-next-6")).toThrow(TerminalProviderError);
  });

  it("merges once and keeps the table in state", () => {
    const ctx = createFakeAnthropicContext();

    const first = getPrices(ctx);

    expect(ctx.state.prices).toBe(first);
    expect(getPrices(ctx)).toBe(first);
  });
});
