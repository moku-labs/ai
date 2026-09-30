import { describe, expect, it } from "vitest";
import { resolveArkImageModel } from "../../image/models";
import { resolveArkModel } from "../../models";
import {
  costUsd,
  estimateTokens,
  estimateUsd,
  imageCostUsd,
  nearestResolution,
  pricePerMillionUsd
} from "../../prices";
import { DEFAULT_CONFIG } from "../fixtures";

const INTL = resolveArkModel("dreamina-seedance-2-0-260128", "intl");
const INTL_25 = resolveArkModel("dreamina-seedance-2-5-260628", "intl");
const MINI = resolveArkModel("dreamina-seedance-2-0-mini-260615", "intl");
const CN = resolveArkModel("doubao-seedance-2-0-260128", "cn");
const SEEDREAM = resolveArkImageModel(undefined, "intl");

describe("estimateTokens", () => {
  it("is w x h x (24 x seconds + 1) / 1024, rounded down, for each resolution", () => {
    expect(estimateTokens("720p", 5)).toBe(108_900);
    expect(estimateTokens("720p", 10)).toBe(216_900);
  });

  it("matches the tokens billed on the live runs", () => {
    // source: live BytePlus intl 2026-09-30: 2.0 480p 9:16 billed 50,638; 2.5 final 1080p billed 245,025
    expect(estimateTokens("480p", 5)).toBe(50_638);
    expect(estimateTokens("1080p", 5)).toBe(245_025);
  });

  it("throws for a resolution without a pixel size", () => {
    expect(() => estimateTokens("4k", 5)).toThrow(
      '[ai] ark has no pixel size for resolution "4k".\n  Use 480p, 720p or 1080p.'
    );
  });
});

describe("nearestResolution", () => {
  it("keeps a listed resolution", () => {
    expect(nearestResolution("1080p")).toBe("1080p");
  });

  it("picks the nearest line count for another <n>p", () => {
    expect(nearestResolution("540p")).toBe("480p");
    expect(nearestResolution("900p")).toBe("720p");
    expect(nearestResolution("1440p")).toBe("1080p");
  });

  it("falls back to 720p for anything else", () => {
    expect(nearestResolution("4k")).toBe("720p");
    expect(nearestResolution("")).toBe("720p");
  });
});

describe("pricePerMillionUsd", () => {
  it("is the intl catalog price in USD", () => {
    expect(pricePerMillionUsd(DEFAULT_CONFIG, INTL, false, "720p")).toBe(7);
    expect(pricePerMillionUsd(DEFAULT_CONFIG, INTL, true, "720p")).toBe(4.3);
  });

  it("uses price1080 at 1080p when the row has one", () => {
    expect(pricePerMillionUsd(DEFAULT_CONFIG, INTL, false, "1080p")).toBe(7.7);
    expect(pricePerMillionUsd(DEFAULT_CONFIG, INTL, true, "1080p")).toBe(4.7);
    expect(pricePerMillionUsd(DEFAULT_CONFIG, INTL_25, false, "1080p")).toBe(11.7);
    expect(pricePerMillionUsd(DEFAULT_CONFIG, INTL_25, true, "1080p")).toBe(7);
    expect(pricePerMillionUsd(DEFAULT_CONFIG, INTL_25, false, "480p")).toBe(10.7);
  });

  it("uses the base price at 1080p when the row has no price1080", () => {
    expect(pricePerMillionUsd(DEFAULT_CONFIG, CN, false, "1080p")).toBeCloseTo(46 / 7.1, 10);
  });

  it("has the official mini price", () => {
    expect(pricePerMillionUsd(DEFAULT_CONFIG, MINI, false, "480p")).toBe(3.5);
    expect(pricePerMillionUsd(DEFAULT_CONFIG, MINI, true, "480p")).toBe(2.1);
  });

  it("converts the cn catalog price from CNY with cnyPerUsd", () => {
    expect(pricePerMillionUsd(DEFAULT_CONFIG, CN, false, "720p")).toBeCloseTo(46 / 7.1, 10);
    expect(pricePerMillionUsd({ ...DEFAULT_CONFIG, cnyPerUsd: 7 }, CN, true, "720p")).toBe(4);
  });

  it("lets priceOverrides win, in USD, for both inputs and every resolution", () => {
    const config = { ...DEFAULT_CONFIG, priceOverrides: { [CN.id]: 5, [INTL.id]: 2 } };
    expect(pricePerMillionUsd(config, CN, false, "720p")).toBe(5);
    expect(pricePerMillionUsd(config, CN, true, "720p")).toBe(5);
    expect(pricePerMillionUsd(config, INTL, false, "1080p")).toBe(2);
  });
});

describe("costUsd", () => {
  it("is tokens / 1e6 x price, rounded to micro-dollars", () => {
    expect(costUsd(DEFAULT_CONFIG, INTL, 108_900, false, "720p")).toBe(0.7623);
    expect(costUsd(DEFAULT_CONFIG, INTL, 108_900, true, "720p")).toBe(0.468_27);
    expect(costUsd(DEFAULT_CONFIG, CN, 108_900, false, "720p")).toBe(0.705_549);
    expect(costUsd(DEFAULT_CONFIG, CN, 108_900, true, "720p")).toBe(0.429_465);
  });

  it("matches the live 2.0 480p bill: 50,638 tokens at $7/M", () => {
    expect(costUsd(DEFAULT_CONFIG, INTL, 50_638, false, "480p")).toBe(0.354_466);
  });

  it("prices a 1080p clip with price1080", () => {
    expect(costUsd(DEFAULT_CONFIG, INTL_25, 245_025, false, "1080p")).toBe(2.866_793);
  });

  it("is 0 for 0 tokens", () => {
    expect(costUsd(DEFAULT_CONFIG, INTL, 0, false, "720p")).toBe(0);
  });
});

describe("estimateUsd", () => {
  it("prices the default 5 s at 720p with the base price", () => {
    expect(estimateUsd(DEFAULT_CONFIG, INTL, {})).toBe(0.7623);
  });

  it("uses the request's seconds and resolution", () => {
    expect(estimateUsd(DEFAULT_CONFIG, INTL, { seconds: 10, resolution: "480p" })).toBe(0.706_006);
  });

  it("uses price1080 for a 1080p request", () => {
    expect(estimateUsd(DEFAULT_CONFIG, INTL, { resolution: "1080p" })).toBe(1.886_692);
  });

  it("converts cn to USD", () => {
    expect(estimateUsd(DEFAULT_CONFIG, CN, {})).toBe(0.705_549);
  });
});

describe("imageCostUsd", () => {
  it("is the catalog price per image", () => {
    expect(imageCostUsd(DEFAULT_CONFIG, SEEDREAM, 1)).toBe(0.035);
    expect(imageCostUsd(DEFAULT_CONFIG, SEEDREAM, 2)).toBe(0.07);
  });

  it("lets priceOverrides win, as USD per image", () => {
    const config = { ...DEFAULT_CONFIG, priceOverrides: { [SEEDREAM.id]: 0.02 } };
    expect(imageCostUsd(config, SEEDREAM, 1)).toBe(0.02);
  });
});
