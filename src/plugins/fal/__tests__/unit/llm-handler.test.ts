import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { PromptGenHandler } from "../../../promptGen/contract";
import { createPromptGenHandler } from "../../llm/handler";
import { TerminalProviderError } from "../../types";
import { createFakeEnv, createTestCtx, stubFetch } from "./fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// ("prompt-gen", "fal"): estimate needs no key and no network.
// ─────────────────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("estimate", () => {
  it("prices system + prompt tokens and max tokens, without the key or a call", () => {
    const fetchMock = stubFetch();
    const handler = createPromptGenHandler(createTestCtx({ env: createFakeEnv({}) }));
    expect(handler.estimate({ prompt: "abcd" })).toEqual({ usd: 0.640_004 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the request's model and max_tokens", () => {
    const handler = createPromptGenHandler(createTestCtx());
    const request = {
      prompt: "abcd",
      system: "abcdefgh",
      model: "anthropic/claude-sonnet-5",
      params: { max_tokens: 1000 }
    };
    expect(handler.estimate(request)).toEqual({ usd: 0.010_006 });
  });

  it("maps an omitted model and default to llmDefaultModel", () => {
    const handler = createPromptGenHandler(
      createTestCtx({ config: { llmDefaultModel: "google/gemini-3.8-flash" } })
    );
    const expected = { usd: 0.120_001 };
    expect(handler.estimate({ prompt: "abcd", params: { max_tokens: 32_000 } })).toEqual(expected);
    expect(
      handler.estimate({ prompt: "abcd", model: "default", params: { max_tokens: 32_000 } })
    ).toEqual(expected);
  });

  it("refuses a model without a price as a terminal 400", () => {
    const handler = createPromptGenHandler(createTestCtx());
    expect(() => handler.estimate({ prompt: "p", model: "meta/llama-9" })).toThrow(
      TerminalProviderError
    );
  });

  it("satisfies the prompt-gen contract", () => {
    expectTypeOf(createPromptGenHandler(createTestCtx())).toEqualTypeOf<PromptGenHandler>();
  });
});
