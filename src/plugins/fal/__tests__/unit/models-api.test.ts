import { describe, expect, expectTypeOf, it } from "vitest";
import { createFalApi } from "../../api";
import type { FalModelInfo } from "../../types";
import { falAliases } from "../../video/models";
import { createFakeEnv, createTestCtx } from "./fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// app.fal.models(task): catalog order, effective prices, no key, no network.
// ─────────────────────────────────────────────────────────────────────────────

describe("createFalApi().models()", () => {
  it("lists the six prompt-gen models with their per-M-token prices", () => {
    const models = createFalApi(createTestCtx()).models("prompt-gen");
    expect(models).toEqual([
      { id: "anthropic/claude-opus-5.5", price: { inputPerM: 4, outputPerM: 20 } },
      { id: "anthropic/claude-sonnet-5", price: { inputPerM: 2, outputPerM: 10 } },
      { id: "openai/gpt-6-sol", price: { inputPerM: 2, outputPerM: 10 } },
      { id: "openai/gpt-6-astra", price: { inputPerM: 10, outputPerM: 50 } },
      { id: "google/gemini-3.8-flash", price: { inputPerM: 0.75, outputPerM: 3.75 } },
      { id: "x-ai/grok-4.7", price: { inputPerM: 2, outputPerM: 6 } }
    ]);
  });

  it("lists the two music models with their billing unit", () => {
    expect(createFalApi(createTestCtx()).models("music")).toEqual([
      { id: "elevenlabs-music-v2.5", price: { usd: 0.8, per: "minute" } },
      { id: "stable-audio-2.5", price: { usd: 0.2, per: "generation" } }
    ]);
  });

  it("lists the three image models at their default resolution", () => {
    expect(createFalApi(createTestCtx()).models("image")).toEqual([
      { id: "nano-banana-pro", price: { usd: 0.15, per: "image" } },
      { id: "seedream-4.5-edit", price: { usd: 0.04, per: "image" } },
      { id: "gpt-image-2.5", price: { usd: 0.05, per: "image" } }
    ]);
  });

  it("lists every video alias per second at its default resolution, audio off", () => {
    const models = createFalApi(createTestCtx()).models("video");
    expect(models.map(model => model.id)).toEqual(falAliases());
    expect(models[0]).toEqual({ id: "seedance-2.5", price: { usd: 0.473, per: "second" } });
    expect(models.find(model => model.id === "minimax-h3")?.price).toEqual({
      usd: 0.06,
      per: "second"
    });
    expect(models.find(model => model.id === "kling-3-pro")?.price).toEqual({
      usd: 0.112,
      per: "second"
    });
    expect(models.find(model => model.id === "veo-3.1-fast")?.price).toEqual({
      usd: 0.1,
      per: "second"
    });
  });

  it("reflects priceOverrides for every task", () => {
    const ctx = createTestCtx({
      config: {
        priceOverrides: {
          "seedance-2.5@720p": 0.5,
          "image:gpt-image-2.5": 0.07,
          "music:stable-audio-2.5": 0.3,
          "llm:anthropic/claude-opus-5.5#out": 25
        }
      }
    });
    const api = createFalApi(ctx);
    expect(api.models("video")[0]?.price).toEqual({ usd: 0.5, per: "second" });
    expect(api.models("image")[2]?.price).toEqual({ usd: 0.07, per: "image" });
    expect(api.models("music")[1]?.price).toEqual({ usd: 0.3, per: "generation" });
    expect(api.models("prompt-gen")[0]?.price).toEqual({ inputPerM: 4, outputPerM: 25 });
  });

  it("needs no key", () => {
    const api = createFalApi(createTestCtx({ env: createFakeEnv({}) }));
    expect(api.models("music")).toHaveLength(2);
  });

  it("rejects an unknown task at runtime", () => {
    const api = createFalApi(createTestCtx());
    // @ts-expect-error — "audio" is not a fal task
    expect(() => api.models("audio")).toThrow(
      '[ai] Unknown fal task "audio".\n  Use one of: video, image, prompt-gen, music.'
    );
  });

  it("types the result as FalModelInfo[] and narrows on inputPerM", () => {
    const api = createFalApi(createTestCtx());
    const [first] = api.models("prompt-gen");
    expectTypeOf(api.models).returns.toEqualTypeOf<FalModelInfo[]>();
    expectTypeOf(api.models("prompt-gen")).toEqualTypeOf<FalModelInfo[]>();
    if (first === undefined) throw new Error("no model");
    if ("inputPerM" in first.price) {
      expectTypeOf(first.price).toEqualTypeOf<{ inputPerM: number; outputPerM: number }>();
      expect(first.price.inputPerM).toBe(4);
    } else {
      throw new Error("prompt-gen prices are per M tokens");
    }
  });

  it("keeps info() unchanged: the video aliases", () => {
    expect(createFalApi(createTestCtx()).info().models).toEqual(falAliases());
  });
});
