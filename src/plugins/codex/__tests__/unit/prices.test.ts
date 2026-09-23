import { describe, expect, it } from "vitest";
import { bundledPrices, mergePrices, priceOf, resolvePrices } from "../../prices";
import { createTestCtx } from "./fixtures";

describe("bundledPrices", () => {
  it("bundles gpt-6-astra as an explicit zero (plan-billed)", () => {
    expect(bundledPrices).toEqual({ "gpt-6-astra": 0 });
  });
});

describe("mergePrices", () => {
  it("returns the bundled table when no overrides are given", () => {
    expect(mergePrices({})).toEqual(bundledPrices);
  });

  it("lets overrides win and add models", () => {
    expect(mergePrices({ "gpt-6-astra": 0.01, other: 0.02 })).toEqual({
      "gpt-6-astra": 0.01,
      other: 0.02
    });
  });
});

describe("resolvePrices", () => {
  it("computes and caches the merged table on first call", () => {
    const ctx = createTestCtx({ config: { priceOverrides: { custom: 0.5 } } });

    const prices = resolvePrices(ctx);

    expect(prices.custom).toBe(0.5);
    expect(ctx.state.prices).toBe(prices);
    expect(resolvePrices(ctx)).toBe(prices);
  });
});

describe("priceOf", () => {
  it("returns the price of a known model, including an explicit zero", () => {
    expect(priceOf(createTestCtx(), "gpt-6-astra")).toBe(0);
  });

  it("throws the pinned two-line error for an unknown model", () => {
    expect(() => priceOf(createTestCtx(), "mystery")).toThrow(
      '[ai] No price for codex model "mystery".\n  Add it to codex priceOverrides.'
    );
  });
});
