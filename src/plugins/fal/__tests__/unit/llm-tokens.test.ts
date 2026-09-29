import { describe, expect, it } from "vitest";
import { actualUsd, estimateTokens, estimateUsd } from "../../llm/tokens";

// ─────────────────────────────────────────────────────────────────────────────
// LLM cost: token estimate, estimate USD, actual USD and its source.
// ─────────────────────────────────────────────────────────────────────────────

const OPUS = { inputPerM: 4, outputPerM: 20 };

describe("estimateTokens", () => {
  it.each([
    ["", 0],
    ["abcd", 1],
    ["abcde", 2],
    ["日本語", 3],
    ["ab日本", 3],
    ["😀", 1]
  ])("%j → %d tokens", (text, tokens) => {
    expect(estimateTokens(text)).toBe(tokens);
  });
});

describe("estimateUsd", () => {
  it("prices input and output per million tokens", () => {
    expect(estimateUsd(OPUS, 1000, 500)).toBe(0.014);
  });

  it("rounds to micro-dollars", () => {
    expect(estimateUsd({ inputPerM: 1.6, outputPerM: 4.8 }, 1, 1)).toBe(0.000_006);
  });
});

describe("actualUsd", () => {
  const request = { system: "abcd", prompt: "abcd" };

  it("takes usage.cost when fal reports it", () => {
    const cost = actualUsd({ usage: { cost: 0.0123, prompt_tokens: 1 }, text: "x" }, OPUS, request);
    expect(cost).toEqual({ usd: 0.0123, source: "usage" });
  });

  it("prices the reported token counts when there is no usable cost", () => {
    const usage = { cost: -1, prompt_tokens: 1000, completion_tokens: 2000 };
    expect(actualUsd({ usage, text: "x" }, OPUS, request)).toEqual({
      usd: 0.044,
      source: "tokens"
    });
  });

  it("falls back to the character rule on system + prompt and the output", () => {
    expect(actualUsd({ usage: undefined, text: "abcdefgh" }, OPUS, request)).toEqual({
      usd: 0.000_048,
      source: "chars"
    });
  });
});
