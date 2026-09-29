import { describe, expect, it, vi } from "vitest";
import { createApimodelsApi } from "../../api";
import { createFakeEnv, createTestCtx } from "./fixtures";

describe("createApimodelsApi().info()", () => {
  it("reports configured and the four Seedance aliases when the key env var is set", () => {
    const api = createApimodelsApi(createTestCtx());
    expect(api.info()).toEqual({
      provider: "apimodels",
      configured: true,
      models: ["seedance-2.5", "seedance-2.5-ref", "seedance-2.0", "seedance-2.0-ref"]
    });
  });

  it("reports not configured when the key env var is absent", () => {
    const api = createApimodelsApi(createTestCtx({ env: createFakeEnv({}) }));
    expect(api.info().configured).toBe(false);
  });

  it("checks the configured apiKeyEnv, not a hard-coded name", () => {
    const ctx = createTestCtx({
      config: { apiKeyEnv: "MY_APIMODELS" },
      env: createFakeEnv({ MY_APIMODELS: "k" })
    });
    expect(createApimodelsApi(ctx).info().configured).toBe(true);
  });

  it("makes no network call", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    createApimodelsApi(createTestCtx()).info();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
