import { describe, expect, it } from "vitest";
import { TerminalProviderError } from "../../errors";
import { imagePriceOf } from "../../image/prices";
import { llmPriceOf, llmPriceRows } from "../../llm/prices";
import { musicPriceOf } from "../../music/prices";
import { mergePrices, missingPriceError, prefixKeys, resolvePrices } from "../../prices";
import { videoPrices as bundledPrices, lookupPrice, videoCostUsd } from "../../video/prices";
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
      "minimax-h3-max-i2v@480P": 0.05,
      "minimax-h3-max-i2v@768P": 0.08,
      "minimax-h3-max-i2v@1080P": 0.16,
      "minimax-h3-ref@480P": 0.05,
      "minimax-h3-ref@768P": 0.06,
      "minimax-h3-ref@2K": 0.13,
      "minimax-h3-ref@4K": 0.16,
      "minimax-h3-ref#refImagesIncluded": 5,
      "minimax-h3-ref#refImageUsd": 0.08,
      "minimax-h3-max-extend@480P": 0.05,
      "minimax-h3-max-extend@768P": 0.08,
      "minimax-h3-max-extend@1080P": 0.16,
      "minimax-h3-max-extend@2K": 0.32,
      "minimax-h3-max-extend#refTokensIncluded": 4096,
      "minimax-h3-max-extend#refTokenUsdPer1k": 0.02,
      "kling-3-pro": 0.112,
      "kling-3-pro+audio": 0.168,
      "kling-o3-ref": 0.112,
      "kling-o3-ref+audio": 0.14,
      "kling-o3-v2v-ref": 0.168,
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
      "vidu-q3-ref@1080p": 0.154,
      "gemini-omni-1.1-flash@360p": 0.03,
      "gemini-omni-1.1-flash@720p": 0.1,
      "gemini-omni-1.1-flash@1080p": 0.15,
      "gemini-omni-1.1-flash@4k": 0.3,
      "gemini-omni-1.1-flash-ref@360p": 0.03,
      "gemini-omni-1.1-flash-ref@720p": 0.1,
      "gemini-omni-1.1-flash-ref@1080p": 0.15,
      "gemini-omni-1.1-flash-ref@4k": 0.3
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

describe("merged table of every task", () => {
  const merged = mergePrices({});

  it("keeps the video keys unprefixed", () => {
    expect(merged["minimax-h3@768P"]).toBe(0.06);
    expect(Object.keys(merged).some(key => key.startsWith("video:"))).toBe(false);
  });

  it("carries the image rows under image:", () => {
    expect(merged["image:nano-banana-pro@1K"]).toBe(0.15);
    expect(merged["image:nano-banana-pro@2K"]).toBe(0.15);
    expect(merged["image:nano-banana-pro@4K"]).toBe(0.3);
    expect(merged["image:seedream-4.5-edit"]).toBe(0.04);
    expect(merged["image:gpt-image-2.5"]).toBe(0.05);
  });

  it("carries the music rows under music:", () => {
    expect(merged["music:elevenlabs-music-v2.5"]).toBe(0.8);
    expect(merged["music:stable-audio-2.5"]).toBe(0.2);
  });

  it("carries two llm: rows per priced model, eight models", () => {
    const llmKeys = Object.keys(merged).filter(key => key.startsWith("llm:"));
    expect(llmKeys).toHaveLength(16);
    expect(merged["llm:anthropic/claude-opus-5.5#in"]).toBe(4);
    expect(merged["llm:anthropic/claude-opus-5.5#out"]).toBe(20);
    expect(merged["llm:google/gemini-2.5-flash#out"]).toBe(2.5);
  });

  it("lets an override win over a prefixed row", () => {
    const table = mergePrices({ "image:gpt-image-2.5": 0.07, "llm:x-ai/grok-4.7#in": 2 });
    expect(table["image:gpt-image-2.5"]).toBe(0.07);
    expect(table["llm:x-ai/grok-4.7#in"]).toBe(2);
    expect(table["llm:x-ai/grok-4.7#out"]).toBe(6);
  });

  it("prefixKeys copies a table under a prefix", () => {
    const table = { a: 1 };
    expect(prefixKeys("music", table)).toEqual({ "music:a": 1 });
    expect(table).toEqual({ a: 1 });
  });

  it("missingPriceError is a terminal 400 naming the task and the model", () => {
    const error = missingPriceError("prompt-gen", "x/y");
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error.status).toBe(400);
    expect(error.message).toBe(
      '[ai] No price for fal prompt-gen model "x/y".\n  Add it to fal.priceOverrides.'
    );
  });
});

describe("task price lookups", () => {
  const merged = mergePrices({});

  it("imagePriceOf tries <alias>@<resolution>, then <alias>", () => {
    expect(imagePriceOf(merged, "nano-banana-pro", "4K")).toBe(0.3);
    expect(imagePriceOf(merged, "gpt-image-2.5", "2K")).toBe(0.06);
    expect(imagePriceOf(merged, "gpt-image-2.5", "1080")).toBe(0.05);
    expect(imagePriceOf(merged, "seedream-4.5-edit", undefined)).toBe(0.04);
    expect(() => imagePriceOf(merged, "nano-banana-pro", undefined)).toThrow(
      '[ai] No price for fal image model "nano-banana-pro".'
    );
  });

  it("musicPriceOf bills per started minute or per generation", () => {
    expect(musicPriceOf(merged, "elevenlabs-music-v2.5", "minute", 60_000)).toBe(0.8);
    expect(musicPriceOf(merged, "elevenlabs-music-v2.5", "minute", 60_001)).toBe(1.6);
    expect(musicPriceOf(merged, "elevenlabs-music-v2.5", "minute", 3000)).toBe(0.8);
    expect(musicPriceOf(merged, "stable-audio-2.5", "generation", 190_000)).toBe(0.2);
    expect(() => musicPriceOf(merged, "x", "generation", 1000)).toThrow(
      '[ai] No price for fal music model "x".'
    );
  });

  it("llmPriceOf needs both rows", () => {
    expect(llmPriceOf(merged, "openai/gpt-6-astra")).toEqual({ inputPerM: 10, outputPerM: 50 });
    expect(() => llmPriceOf({ "llm:a/b#in": 1 }, "a/b")).toThrow(
      '[ai] No price for fal prompt-gen model "a/b".'
    );
  });

  it("llmPriceRows lists the eight bundled models", () => {
    expect(Object.keys(llmPriceRows())).toHaveLength(16);
  });
});
