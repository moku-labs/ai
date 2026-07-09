import { describe, expect, it } from "vitest";
import {
  bundledPrices,
  estimateChatCostUsd,
  estimateTokenCount,
  estimateTtsCostUsd,
  getPrices
} from "../../prices";
import { createFakeOpenaiContext } from "./fixtures";

describe("openai unit: prices", () => {
  describe("getPrices", () => {
    it("returns the bundled table merged with no overrides by default", () => {
      const ctx = createFakeOpenaiContext();

      const prices = getPrices(ctx);

      expect(prices["gpt-4o-mini"]).toEqual(bundledPrices["gpt-4o-mini"]);
    });

    it("merges config.priceOverrides field-by-field over the bundled entry", () => {
      const ctx = createFakeOpenaiContext({
        config: { priceOverrides: { "gpt-4o-mini": { inputPerM: 999 } } }
      });

      const prices = getPrices(ctx);

      expect(prices["gpt-4o-mini"]).toEqual({ inputPerM: 999, outputPerM: 0.6 });
    });

    it("adds a wholly new model entry from priceOverrides", () => {
      const ctx = createFakeOpenaiContext({
        config: { priceOverrides: { "custom-model": { ttsPerMChars: 42 } } }
      });

      const prices = getPrices(ctx);

      expect(prices["custom-model"]).toEqual({ ttsPerMChars: 42 });
    });

    it("caches the computed table on ctx.state.prices", () => {
      const ctx = createFakeOpenaiContext();

      const first = getPrices(ctx);
      const second = getPrices(ctx);

      expect(first).toBe(second);
      expect(ctx.state.prices).toBe(first);
    });
  });

  describe("estimateTokenCount", () => {
    it("estimates ~1 token per 4 characters, rounding up", () => {
      expect(estimateTokenCount("")).toBe(0);
      expect(estimateTokenCount("abc")).toBe(1);
      expect(estimateTokenCount("abcd")).toBe(1);
      expect(estimateTokenCount("abcde")).toBe(2);
    });
  });

  describe("estimateChatCostUsd", () => {
    it("computes input + output cost from per-million-token prices", () => {
      const prices = { "gpt-4o-mini": { inputPerM: 0.15, outputPerM: 0.6 } };

      const usd = estimateChatCostUsd(prices, "gpt-4o-mini", 1_000_000, 1_000_000);

      expect(usd).toBeCloseTo(0.75, 6);
    });

    it("prices an unlisted model as free (0 USD)", () => {
      const usd = estimateChatCostUsd({}, "unknown-model", 1000, 1000);

      expect(usd).toBe(0);
    });
  });

  describe("estimateTtsCostUsd", () => {
    it("computes cost from a per-million-character price", () => {
      const prices = { "gpt-4o-mini-tts": { ttsPerMChars: 15 } };

      const usd = estimateTtsCostUsd(prices, "gpt-4o-mini-tts", 1_000_000);

      expect(usd).toBeCloseTo(15, 6);
    });

    it("prices an unlisted model as free (0 USD)", () => {
      expect(estimateTtsCostUsd({}, "unknown-model", 1000)).toBe(0);
    });
  });
});
