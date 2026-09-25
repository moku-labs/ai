import { describe, expect, it } from "vitest";
import { bundledPrices, lookupPrice, mergePrices, resolvePrices, videoCostUsd } from "../../prices";
import { createTestCtx } from "./fixtures";

describe("bundled price table", () => {
  it("carries the spec's USD-per-second rows", () => {
    expect(bundledPrices).toEqual({
      "seedance-2.5@480p": 0.2205,
      "seedance-2.5@720p": 0.473,
      "seedance-2.5-ref@480p": 0.2205,
      "seedance-2.5-ref@720p": 0.473,
      "minimax-h3@480P": 0.05,
      "minimax-h3@768P": 0.06,
      "minimax-h3@2K": 0.13,
      "minimax-h3@4K": 0.16,
      "minimax-h3-max-ref@480P": 0.05,
      "minimax-h3-max-ref@768P": 0.08,
      "minimax-h3-max-ref@1080P": 0.16,
      "minimax-h3-max-ref#refTokensIncluded": 4096,
      "minimax-h3-max-ref#refTokenUsdPer1k": 0.02,
      "kling-3-pro": 0.112,
      "kling-3-pro+audio": 0.168,
      "kling-o3-ref": 0.112,
      "kling-o3-ref+audio": 0.14,
      "seedance-2.0-mini@480p": 0.0721,
      "seedance-2.0-mini@720p": 0.1547,
      "seedance-2.0-mini-ref@480p": 0.0721,
      "seedance-2.0-mini-ref@720p": 0.1547,
      "seedance-2.0-ref@720p": 0.3034,
      "seedance-2.0-ref@1080p": 0.682,
      "wan-3.0-ref@480p": 0.05,
      "wan-3.0-ref@720p": 0.1,
      "wan-3.0-ref@1080p": 0.2,
      "veo-3.1-fast@4k": 0.35,
      "veo-3.1-fast+audio": 0.15,
      "veo-3.1-fast": 0.1,
      "vidu-q3@360p": 0.07,
      "vidu-q3@540p": 0.07,
      "vidu-q3@720p": 0.154,
      "vidu-q3@1080p": 0.154,
      "vidu-q3-ref@360p": 0.07,
      "vidu-q3-ref@540p": 0.07,
      "vidu-q3-ref@720p": 0.154,
      "vidu-q3-ref@1080p": 0.154
    });
  });

  it("mergePrices lets overrides win and add keys", () => {
    const merged = mergePrices({ "kling-3-pro": 0.2, "minimax-h3@1080P": 0.09 });
    expect(merged["kling-3-pro"]).toBe(0.2);
    expect(merged["minimax-h3@1080P"]).toBe(0.09);
    expect(merged["minimax-h3@768P"]).toBe(0.06);
  });

  it("resolvePrices caches the merged table in state", () => {
    const ctx = createTestCtx({ config: { priceOverrides: { "kling-3-pro": 0.3 } } });
    const first = resolvePrices(ctx);
    expect(ctx.state.prices).toBe(first);
    expect(resolvePrices(ctx)).toBe(first);
    expect(first["kling-3-pro"]).toBe(0.3);
  });
});

describe("lookupPrice", () => {
  const prices = mergePrices({});

  it("uses <alias>@<resolution> first", () => {
    expect(lookupPrice(prices, "minimax-h3", "2K", false)).toBe(0.13);
    expect(lookupPrice(prices, "seedance-2.5", "480p", true)).toBe(0.2205);
  });

  it("uses <alias>+audio when audio is on, else <alias>", () => {
    expect(lookupPrice(prices, "kling-3-pro", undefined, true)).toBe(0.168);
    expect(lookupPrice(prices, "kling-3-pro", undefined, false)).toBe(0.112);
    expect(lookupPrice(prices, "kling-o3-ref", undefined, true)).toBe(0.14);
  });

  it("falls back to <alias> when the resolution has no row", () => {
    expect(lookupPrice(prices, "kling-3-pro", "1080p", false)).toBe(0.112);
  });

  it("throws the pinned two-line error when no row matches", () => {
    expect(() => lookupPrice(prices, "minimax-h3", "1080P", false)).toThrow(
      '[ai] No price for fal model "minimax-h3" (1080P, audio off).\n  Add it to fal priceOverrides.'
    );
    expect(() => lookupPrice({}, "kling-3-pro", undefined, true)).toThrow(
      '[ai] No price for fal model "kling-3-pro" (default, audio on).\n  Add it to fal priceOverrides.'
    );
  });
});

describe("videoCostUsd", () => {
  it("is seconds x price, seconds default 5", () => {
    const ctx = createTestCtx();
    expect(videoCostUsd(ctx, { model: "minimax-h3", prompt: "p" })).toBe(0.3);
    expect(videoCostUsd(ctx, { model: "seedance-2.5", prompt: "p", seconds: 10 })).toBe(4.73);
    expect(videoCostUsd(ctx, { model: "kling-3-pro", prompt: "p", audio: true })).toBe(0.84);
  });

  it("prices minimax-h3 as silent even when audio is requested", () => {
    const ctx = createTestCtx({ config: { priceOverrides: { "minimax-h3+audio": 9 } } });
    expect(
      videoCostUsd(ctx, { model: "minimax-h3", prompt: "p", audio: true, resolution: "4K" })
    ).toBe(0.8);
  });

  it("honors a config override", () => {
    const ctx = createTestCtx({ config: { priceOverrides: { "kling-o3-ref": 0.2 } } });
    expect(videoCostUsd(ctx, { model: "kling-o3-ref", prompt: "p", seconds: 3 })).toBe(0.6);
  });

  it("throws for an unknown alias", () => {
    expect(() => videoCostUsd(createTestCtx(), { model: "veo-9", prompt: "p" })).toThrow(
      'Unknown fal video model "veo-9"'
    );
  });
});

describe("prices of the catalog additions", () => {
  const prices = mergePrices({});

  it.each([
    ["seedance-2.0-mini@480p", 0.0721],
    ["seedance-2.0-mini@720p", 0.1547],
    ["seedance-2.0-mini-ref@480p", 0.0721],
    ["seedance-2.0-mini-ref@720p", 0.1547],
    ["seedance-2.0-ref@720p", 0.3034],
    ["seedance-2.0-ref@1080p", 0.682],
    ["wan-3.0-ref@480p", 0.05],
    ["wan-3.0-ref@720p", 0.1],
    ["wan-3.0-ref@1080p", 0.2],
    ["veo-3.1-fast@4k", 0.35],
    ["veo-3.1-fast+audio", 0.15],
    ["veo-3.1-fast", 0.1],
    ["vidu-q3@360p", 0.07],
    ["vidu-q3@540p", 0.07],
    ["vidu-q3@720p", 0.154],
    ["vidu-q3@1080p", 0.154],
    ["vidu-q3-ref@360p", 0.07],
    ["vidu-q3-ref@540p", 0.07],
    ["vidu-q3-ref@720p", 0.154],
    ["vidu-q3-ref@1080p", 0.154]
  ])("bundles %s at %d USD/s", (key, usd) => {
    expect(bundledPrices[key]).toBe(usd);
  });

  it("veo-3.1-fast at 720p falls back to +audio when audio is on, else to the base price", () => {
    expect(lookupPrice(prices, "veo-3.1-fast", "720p", true)).toBe(0.15);
    expect(lookupPrice(prices, "veo-3.1-fast", "720p", false)).toBe(0.1);
  });

  it("veo-3.1-fast at 4k takes the 4k price with or without audio", () => {
    expect(lookupPrice(prices, "veo-3.1-fast", "4k", true)).toBe(0.35);
    expect(lookupPrice(prices, "veo-3.1-fast", "4k", false)).toBe(0.35);
  });

  it.each([
    ["seedance-2.0-mini", 0.7735],
    ["seedance-2.0-mini-ref", 0.7735],
    ["seedance-2.0-ref", 1.517],
    ["wan-3.0-ref", 0.5],
    ["veo-3.1-fast", 0.5],
    ["vidu-q3", 0.77],
    ["vidu-q3-ref", 0.77]
  ])("prices %s for 5 s at its default resolution: %d USD", (model, usd) => {
    expect(videoCostUsd(createTestCtx(), { model, prompt: "p" })).toBe(usd);
  });

  it("prices veo-3.1-fast 8 s with audio at the +audio rate", () => {
    const request = { model: "veo-3.1-fast", prompt: "p", seconds: 8, audio: true };
    expect(videoCostUsd(createTestCtx(), request)).toBe(1.2);
  });
});
