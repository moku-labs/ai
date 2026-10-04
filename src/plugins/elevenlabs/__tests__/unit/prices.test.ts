import { describe, expect, it } from "vitest";
import { TerminalProviderError } from "../../errors";
import { bundledPrices, isSfxPriceKey, mergePrices, resolvePrices, sfxPriceOf } from "../../prices";
import { createTestCtx } from "./fixtures";

describe("bundledPrices", () => {
  it("has a defined, positive price for every bundled model", () => {
    const entries = Object.entries(bundledPrices);

    expect(entries.length).toBeGreaterThan(0);
    for (const [model, price] of entries) {
      expect(model.length).toBeGreaterThan(0);
      expect(price).toBeGreaterThan(0);
    }
  });
});

describe("mergePrices", () => {
  it("returns the bundled table unchanged when no overrides are given", () => {
    expect(mergePrices({})).toEqual(bundledPrices);
  });

  it("overrides win over the bundled price for a shared model key", () => {
    const merged = mergePrices({ eleven_multilingual_v2: 0.001 });

    expect(merged.eleven_multilingual_v2).toBe(0.001);
  });

  it("adds a model not present in the bundled table", () => {
    const merged = mergePrices({ custom_model: 0.0002 });

    expect(merged.custom_model).toBe(0.0002);
  });

  it("leaves un-overridden bundled models untouched", () => {
    const merged = mergePrices({ eleven_multilingual_v2: 0.001 });

    expect(merged.eleven_turbo_v2_5).toBe(bundledPrices.eleven_turbo_v2_5);
  });
});

describe("resolvePrices", () => {
  it("computes and caches the merged table into ctx.state.prices on first call", () => {
    const ctx = createTestCtx({ config: { priceOverrides: { eleven_multilingual_v2: 0.001 } } });
    expect(ctx.state.prices).toBeNull();

    const prices = resolvePrices(ctx);

    expect(prices.eleven_multilingual_v2).toBe(0.001);
    expect(ctx.state.prices).toBe(prices);
  });

  it("reuses the cached table on subsequent calls (does not recompute)", () => {
    const ctx = createTestCtx();

    const first = resolvePrices(ctx);
    const second = resolvePrices(ctx);

    expect(second).toBe(first);
  });
});

describe("sfx prices", () => {
  it("bundles the #second and #auto prices for eleven_text_to_sound_v2", () => {
    expect(bundledPrices["sfx:eleven_text_to_sound_v2#second"]).toBe(0.002);
    expect(bundledPrices["sfx:eleven_text_to_sound_v2#auto"]).toBe(0.01);
  });

  it("sfxPriceOf reads the price for the model and unit", () => {
    expect(sfxPriceOf(bundledPrices, "eleven_text_to_sound_v2", "second")).toBe(0.002);
    expect(sfxPriceOf(bundledPrices, "eleven_text_to_sound_v2", "auto")).toBe(0.01);
  });

  it("sfxPriceOf throws a terminal 400 for a missing price", () => {
    expect(() => sfxPriceOf({}, "eleven_text_to_sound_v2", "auto")).toThrow(TerminalProviderError);
  });

  it("isSfxPriceKey tells sfx keys from voice model keys", () => {
    expect(isSfxPriceKey("sfx:eleven_text_to_sound_v2#auto")).toBe(true);
    expect(isSfxPriceKey("eleven_multilingual_v2")).toBe(false);
  });
});
