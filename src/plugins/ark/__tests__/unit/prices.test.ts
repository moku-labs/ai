import { describe, expect, it } from "vitest";
import { resolveArkModel } from "../../models";
import { costUsd, estimateTokens, estimateUsd, pricePerMillionUsd } from "../../prices";
import { DEFAULT_CONFIG } from "../fixtures";

const INTL = resolveArkModel("dreamina-seedance-2-0-260128", "intl");
const CN = resolveArkModel("doubao-seedance-2-0-260128", "cn");

describe("estimateTokens", () => {
  it("is w x h x 24 x seconds / 1024 for each resolution", () => {
    expect(estimateTokens("480p", 5)).toBe(48_600);
    expect(estimateTokens("720p", 5)).toBe(108_000);
    expect(estimateTokens("1080p", 5)).toBe(243_000);
    expect(estimateTokens("720p", 10)).toBe(216_000);
  });

  it("throws for a resolution without a pixel size", () => {
    expect(() => estimateTokens("4k", 5)).toThrow(
      '[ai] ark has no pixel size for resolution "4k".\n  Use 480p, 720p or 1080p.'
    );
  });
});

describe("pricePerMillionUsd", () => {
  it("is the intl catalog price in USD", () => {
    expect(pricePerMillionUsd(DEFAULT_CONFIG, INTL, false)).toBe(7);
    expect(pricePerMillionUsd(DEFAULT_CONFIG, INTL, true)).toBe(4.3);
  });

  it("converts the cn catalog price from CNY with cnyPerUsd", () => {
    expect(pricePerMillionUsd(DEFAULT_CONFIG, CN, false)).toBeCloseTo(46 / 7.1, 10);
    expect(pricePerMillionUsd({ ...DEFAULT_CONFIG, cnyPerUsd: 7 }, CN, true)).toBe(4);
  });

  it("lets priceOverrides win, in USD, for both inputs", () => {
    const config = { ...DEFAULT_CONFIG, priceOverrides: { [CN.id]: 5 } };
    expect(pricePerMillionUsd(config, CN, false)).toBe(5);
    expect(pricePerMillionUsd(config, CN, true)).toBe(5);
  });
});

describe("costUsd", () => {
  it("is tokens / 1e6 x price, rounded to micro-dollars", () => {
    expect(costUsd(DEFAULT_CONFIG, INTL, 108_900, false)).toBe(0.7623);
    expect(costUsd(DEFAULT_CONFIG, INTL, 108_900, true)).toBe(0.468_27);
    expect(costUsd(DEFAULT_CONFIG, CN, 108_900, false)).toBe(0.705_549);
    expect(costUsd(DEFAULT_CONFIG, CN, 108_900, true)).toBe(0.429_465);
  });

  it("is 0 for 0 tokens", () => {
    expect(costUsd(DEFAULT_CONFIG, INTL, 0, false)).toBe(0);
  });
});

describe("estimateUsd", () => {
  it("prices the default 5 s at 720p with the base price", () => {
    expect(estimateUsd(DEFAULT_CONFIG, INTL, {})).toBe(0.756);
  });

  it("uses the request's seconds and resolution", () => {
    expect(estimateUsd(DEFAULT_CONFIG, INTL, { seconds: 10, resolution: "480p" })).toBe(0.6804);
  });

  it("converts cn to USD", () => {
    expect(estimateUsd(DEFAULT_CONFIG, CN, {})).toBe(0.699_718);
  });
});
