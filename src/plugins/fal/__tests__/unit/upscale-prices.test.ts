import { describe, expect, it } from "vitest";
import { mergePrices } from "../../prices";
import { upscalePriceOf, upscaleRate } from "../../upscale/prices";

// ─────────────────────────────────────────────────────────────────────────────
// fal upscale prices: USD per source second, `upscale:` keys in the merged table.
// ─────────────────────────────────────────────────────────────────────────────

describe("upscale prices", () => {
  it("prices 62.4 s of starlight-fast-2 at 3.744 from the bundled table", () => {
    // Bug: the upscale rows are not merged under `upscale:`, or the product is not rounded to micro-dollars.
    expect(upscalePriceOf(mergePrices({}), "starlight-fast-2", 62.4)).toBe(3.744);
  });

  it("lets priceOverrides win over the bundled row, for the rate and the cost", () => {
    // Bug: an override key with the `upscale:` prefix is ignored and the bundled 0.02 is billed.
    const prices = mergePrices({ "upscale:proteus": 0.03 });
    expect(upscaleRate(prices, "proteus")).toBe(0.03);
    expect(upscalePriceOf(prices, "proteus", 10)).toBe(0.3);
  });

  it("throws the price error for a model without a row", () => {
    // Bug: a model without a price estimates 0 and the budget gate lets a paid job through.
    expect(() => upscalePriceOf({}, "proteus", 10)).toThrow(
      '[ai] No price for fal upscale model "proteus".\n  Add it to fal.priceOverrides.'
    );
  });
});
