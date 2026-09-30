import { describe, expect, it } from "vitest";
import { createArkApi } from "../../api";
import { modelsOf } from "../../models";
import { createFakeEnv, createTestCtx, TEST_ACCESS_KEY, TEST_API_KEY } from "../fixtures";

describe("createArkApi().info()", () => {
  it("reports region, both key sets configured and the region's models", () => {
    const api = createArkApi(createTestCtx());

    expect(api.info()).toEqual({
      provider: "ark",
      region: "intl",
      configured: { video: true, assets: true, image: true },
      models: modelsOf("intl"),
      imageModels: ["seedream-5-0-lite-260128"]
    });
    expect(api.info().models).toEqual([
      "dreamina-seedance-2-0-260128",
      "dreamina-seedance-2-0-fast-260128",
      "dreamina-seedance-2-0-mini-260615",
      "dreamina-seedance-2-5-260628"
    ]);
  });

  it("reports nothing configured, without throwing, when no key is set", () => {
    const api = createArkApi(createTestCtx({ env: createFakeEnv({}) }));
    expect(api.info().configured).toEqual({ video: false, assets: false, image: false });
  });

  it("reports images configured with the API key alone", () => {
    const api = createArkApi(createTestCtx({ env: createFakeEnv({ ARK_API_KEY: TEST_API_KEY }) }));
    expect(api.info().configured).toEqual({ video: true, assets: false, image: true });
  });

  it("needs both the access key and the secret key for assets", () => {
    const api = createArkApi(
      createTestCtx({
        env: createFakeEnv({ ARK_API_KEY: TEST_API_KEY, ARK_ACCESS_KEY: TEST_ACCESS_KEY })
      })
    );
    expect(api.info().configured).toEqual({ video: true, assets: false, image: true });
  });

  it("treats an empty variable as not set", () => {
    const api = createArkApi(createTestCtx({ env: createFakeEnv({ ARK_API_KEY: "" }) }));
    expect(api.info().configured.video).toBe(false);
  });

  it("reads the configured env var names and lists only cn models on cn", () => {
    const ctx = createTestCtx({
      config: { region: "cn", apiKeyEnv: "VOLC_ARK_KEY" },
      env: createFakeEnv({ VOLC_ARK_KEY: "k" })
    });

    const info = createArkApi(ctx).info();

    expect(info.region).toBe("cn");
    expect(info.configured.video).toBe(true);
    expect(info.models).toEqual(modelsOf("cn"));
    expect(info.models).toEqual(["doubao-seedance-2-0-260128", "doubao-seedance-2-5-260628"]);
    expect(info.imageModels).toEqual([]);
  });
});
