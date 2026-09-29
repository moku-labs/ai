import { describe, expect, it, vi } from "vitest";
import {
  assetPriceUsd,
  bundledPrices,
  lookupPerSecond,
  mergePrices,
  resolvePrices,
  roundUsd,
  videoCostUsd
} from "../../prices";
import { TerminalProviderError } from "../../types";
import { createVideoHandler } from "../../video/handler";
import { createTestCtx, thrownBy } from "./fixtures";

describe("bundled price table", () => {
  it("has every alias@resolution key of the spec, plus the asset registration price", () => {
    expect(bundledPrices).toEqual({
      "seedance-2.5@480p": 0.12,
      "seedance-2.5@720p": 0.27,
      "seedance-2.5-ref@480p": 0.12,
      "seedance-2.5-ref@720p": 0.27,
      "seedance-2.0@480p": 0.092,
      "seedance-2.0@720p": 0.197,
      "seedance-2.0@1080p": 0.492,
      "seedance-2.0-ref@480p": 0.092,
      "seedance-2.0-ref@720p": 0.197,
      "seedance-2.0-ref@1080p": 0.492,
      asset: 0.01
    });
  });
});

describe("mergePrices / resolvePrices", () => {
  it("an override replaces the bundled price of its key only", () => {
    const prices = mergePrices({ "seedance-2.5@720p": 0.3 });
    expect(prices["seedance-2.5@720p"]).toBe(0.3);
    expect(prices["seedance-2.5@480p"]).toBe(0.12);
  });

  it("memoizes the merged table in state on first use", () => {
    const ctx = createTestCtx({ config: { priceOverrides: { asset: 0.02 } } });
    const first = resolvePrices(ctx);
    expect(ctx.state.prices).toBe(first);
    expect(resolvePrices(ctx)).toBe(first);
    expect(first.asset).toBe(0.02);
  });
});

describe("lookupPerSecond", () => {
  it("reads alias@resolution", () => {
    expect(lookupPerSecond(bundledPrices, "seedance-2.0-ref", "1080p")).toBe(0.492);
  });

  it("throws a terminal 400 naming priceOverrides for a missing key", () => {
    const error = thrownBy(() => lookupPerSecond({}, "seedance-2.5", "1080p"));
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as TerminalProviderError).status).toBe(400);
    expect((error as Error).message).toBe(
      '[ai] No price for apimodels model "seedance-2.5" at 1080p.\n  Add "seedance-2.5@1080p" to apimodels priceOverrides.'
    );
  });
});

describe("videoCostUsd", () => {
  it("is seconds x USD/s of alias@resolution, rounded to micro-dollars", () => {
    const ctx = createTestCtx();
    expect(videoCostUsd(ctx, { model: "seedance-2.5", prompt: "p", seconds: 8 })).toBe(2.16);
    expect(
      videoCostUsd(ctx, { model: "seedance-2.0", prompt: "p", seconds: 7, resolution: "480p" })
    ).toBe(0.644);
    expect(videoCostUsd(ctx, { model: "seedance-2.0-ref", prompt: "p" })).toBe(0.985);
  });

  it("uses an override", () => {
    const ctx = createTestCtx({ config: { priceOverrides: { "seedance-2.5-ref@480p": 0.1 } } });
    expect(videoCostUsd(ctx, { model: "seedance-2.5-ref", prompt: "p", resolution: "480p" })).toBe(
      0.5
    );
  });
});

describe("assetPriceUsd / roundUsd", () => {
  it("is 0.01 per registration unless overridden", () => {
    expect(assetPriceUsd(createTestCtx())).toBe(0.01);
    expect(assetPriceUsd(createTestCtx({ config: { priceOverrides: { asset: 0.015 } } }))).toBe(
      0.015
    );
  });

  it("rounds float noise away", () => {
    expect(roundUsd(0.1 + 0.2)).toBe(0.3);
  });
});

describe("estimate asset surcharge", () => {
  it("adds the asset price once per params.assets entry, as a worst case, with no network call", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const handler = createVideoHandler(createTestCtx());
    const request = {
      model: "seedance-2.5-ref",
      prompt: "p",
      image: { path: "/a.png", mimeType: "image/png", hash: "h1" },
      refs: [{ path: "/b.png", mimeType: "image/png", hash: "h2" }],
      seconds: 8
    };

    expect(handler.estimate(request).usd).toBe(2.16);
    expect(handler.estimate({ ...request, params: { assets: ["image"] } }).usd).toBe(2.17);
    expect(handler.estimate({ ...request, params: { assets: ["image", "refs.0"] } }).usd).toBe(
      2.18
    );
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
