import { describe, expect, it } from "vitest";
import { createElevenlabsApi } from "../../api";
import { bundledPrices } from "../../prices";
import { createFakeEnv, createTestCtx } from "./fixtures";

describe("createElevenlabsApi", () => {
  describe("info()", () => {
    it('reports provider: "elevenlabs"', () => {
      const api = createElevenlabsApi(createTestCtx());

      expect(api.info().provider).toBe("elevenlabs");
    });

    it("reports configured: true when the API key env var is present, without throwing", () => {
      const api = createElevenlabsApi(
        createTestCtx({ env: createFakeEnv({ ELEVENLABS_API_KEY: "test-key" }) })
      );

      expect(() => api.info()).not.toThrow();
      expect(api.info().configured).toBe(true);
    });

    it("reports configured: false when the API key env var is absent", () => {
      const api = createElevenlabsApi(createTestCtx({ env: createFakeEnv({}) }));

      expect(api.info().configured).toBe(false);
    });

    it("respects a custom config.apiKeyEnv when checking configured", () => {
      const api = createElevenlabsApi(
        createTestCtx({
          config: { apiKeyEnv: "MY_CUSTOM_KEY" },
          env: createFakeEnv({ MY_CUSTOM_KEY: "test-key" })
        })
      );

      expect(api.info().configured).toBe(true);
    });

    it("lists the bundled models by default", () => {
      const api = createElevenlabsApi(createTestCtx());

      expect(api.info().models.toSorted()).toEqual(Object.keys(bundledPrices).toSorted());
    });

    it("includes a price-override-only model in the reported models", () => {
      const api = createElevenlabsApi(
        createTestCtx({ config: { priceOverrides: { custom_model: 0.0001 } } })
      );

      expect(api.info().models).toContain("custom_model");
    });
  });
});
