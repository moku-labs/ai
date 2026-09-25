import { describe, expect, it } from "vitest";
import { createFalApi } from "../../api";
import { createFakeEnv, createTestCtx } from "./fixtures";

describe("createFalApi().info()", () => {
  it("reports configured when the key env var is present", () => {
    const api = createFalApi(createTestCtx());
    expect(api.info()).toEqual({
      provider: "fal",
      configured: true,
      models: [
        "seedance-2.5",
        "seedance-2.5-ref",
        "minimax-h3",
        "minimax-h3-max-ref",
        "kling-3-pro",
        "kling-o3-ref",
        "seedance-2.0-mini",
        "seedance-2.0-mini-ref",
        "seedance-2.0-ref",
        "wan-3.0-ref",
        "veo-3.1-fast",
        "vidu-q3",
        "vidu-q3-ref"
      ]
    });
  });

  it("reports not configured when the key env var is absent", () => {
    const api = createFalApi(createTestCtx({ env: createFakeEnv({}) }));
    expect(api.info().configured).toBe(false);
  });

  it("checks the configured apiKeyEnv, not a hard-coded name", () => {
    const ctx = createTestCtx({
      config: { apiKeyEnv: "MY_FAL" },
      env: createFakeEnv({ MY_FAL: "k" })
    });
    expect(createFalApi(ctx).info().configured).toBe(true);
  });
});
