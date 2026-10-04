import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createSpriteApi, isSpriteHandler } from "../../api";
import type {
  Config,
  RegistryApi,
  SpriteApi,
  SpriteContext,
  SpriteHandler,
  SpriteRequest,
  SpriteResult
} from "../../types";

// ---------------------------------------------------------------------------
// Standard tier: sprite plugin (task contract owner + one-off facade)
// ---------------------------------------------------------------------------

/**
 * In-memory fake mirroring registry's real register/resolve/providers/tasks behavior.
 *
 * @returns A fresh fake registry.
 */
function createFakeRegistry(): RegistryApi {
  const handlers = new Map<string, Map<string, unknown>>();
  return {
    register(task, provider, handler) {
      const taskProviders = handlers.get(task) ?? new Map<string, unknown>();
      taskProviders.set(provider, handler);
      handlers.set(task, taskProviders);
    },
    resolve(task, provider) {
      return handlers.get(task)?.get(provider);
    },
    providers(task) {
      return [...(handlers.get(task)?.keys() ?? [])];
    },
    tasks() {
      return [...handlers.keys()];
    }
  };
}

/**
 * Builds a mock sprite context (config + empty state + no-op emit + a fake registry).
 *
 * @param overrides - Optional config overrides and registry.
 * @param overrides.config - Config fields to override.
 * @param overrides.registry - Registry to hand out from `require`.
 * @returns The mock context.
 */
function createTestCtx(overrides?: {
  config?: Partial<Config>;
  registry?: RegistryApi;
}): SpriteContext {
  const config: Config = { defaultProvider: "fal", ...overrides?.config };
  const registry = overrides?.registry ?? createFakeRegistry();
  return { config, state: {}, emit: () => undefined, require: () => registry };
}

/**
 * Registers `handler` under "sprite"/`provider` and returns a facade over it.
 *
 * @param handler - The value to register.
 * @param provider - The provider name.
 * @returns The sprite facade.
 */
function apiWith(handler: unknown, provider = "fal"): SpriteApi {
  const registry = createFakeRegistry();
  registry.register("sprite", provider, handler);
  return createSpriteApi(createTestCtx({ registry }));
}

const request: SpriteRequest = {
  source: { path: "/store/ab/abcd", mimeType: "image/png", hash: "abcd" },
  model: "birefnet",
  size: { width: 64, height: 64 },
  pixelArt: true
};
const doneResult: SpriteResult = {
  image: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  mimeType: "image/png",
  costUsd: 0.002,
  meta: { width: 64, height: 64 }
};

/**
 * A handler whose `execute` resolves `doneResult` and `estimate` returns `usd`.
 *
 * @param usd - The estimate.
 * @returns The handler and its spies.
 */
function createHandler(usd = 0.002) {
  const execute = vi.fn(async () => doneResult);
  const estimate = vi.fn(() => ({ usd }));
  const handler: SpriteHandler = { estimate, execute };
  return { handler, execute, estimate };
}

describe("standard tier: sprite plugin", () => {
  describe("isSpriteHandler guard", () => {
    it("accepts estimate + execute", () => {
      expect(isSpriteHandler(createHandler().handler)).toBe(true);
    });

    it("rejects a handler without execute, even with submit + poll", () => {
      expect(
        isSpriteHandler({ estimate: () => ({ usd: 0 }), submit: vi.fn(), poll: vi.fn() })
      ).toBe(false);
    });

    it("rejects a handler without estimate", () => {
      expect(isSpriteHandler({ execute: async () => doneResult })).toBe(false);
    });

    it("rejects non-objects", () => {
      expect(isSpriteHandler(undefined)).toBe(false);
      expect(isSpriteHandler("fal")).toBe(false);
    });
  });

  describe("generate", () => {
    it("calls execute once and returns its result", async () => {
      const { handler, execute } = createHandler();
      const api = apiWith(handler);

      const result = await api.generate(request);

      expect(result).toBe(doneResult);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(request, {});
    });

    it("forwards the abort signal to execute", async () => {
      const { handler, execute } = createHandler();
      const api = apiWith(handler);
      const controller = new AbortController();

      await api.generate(request, { signal: controller.signal });

      expect(execute).toHaveBeenCalledWith(request, { signal: controller.signal });
    });

    it("rejects with the handler's error as-is", async () => {
      const error = new Error("matte failed");
      const execute = async (): Promise<SpriteResult> => {
        throw error;
      };
      const api = apiWith({ estimate: () => ({ usd: 0 }), execute });

      await expect(api.generate(request)).rejects.toBe(error);
    });

    it("honors the provider override", async () => {
      const registry = createFakeRegistry();
      const fal = createHandler();
      const other = createHandler();
      registry.register("sprite", "fal", fal.handler);
      registry.register("sprite", "other", other.handler);
      const api = createSpriteApi(createTestCtx({ registry }));

      await api.generate(request, { provider: "other" });

      expect(other.execute).toHaveBeenCalledTimes(1);
      expect(fal.execute).not.toHaveBeenCalled();
    });
  });

  describe("estimate", () => {
    it("returns the handler's estimate without executing", () => {
      const { handler, execute } = createHandler(0.002);
      const api = apiWith(handler);

      expect(api.estimate(request)).toEqual({ usd: 0.002 });
      expect(execute).not.toHaveBeenCalled();
    });

    it("passes the request to the handler unchanged", () => {
      const { handler, estimate } = createHandler();
      const api = apiWith(handler);

      api.estimate(request);

      expect(estimate).toHaveBeenCalledWith(request);
    });

    it("honors the provider override", () => {
      const registry = createFakeRegistry();
      registry.register("sprite", "fal", createHandler(1).handler);
      registry.register("sprite", "other", createHandler(2).handler);
      const api = createSpriteApi(createTestCtx({ registry }));

      expect(api.estimate(request, { provider: "other" })).toEqual({ usd: 2 });
    });

    it("uses config.defaultProvider when the caller names none", () => {
      const registry = createFakeRegistry();
      registry.register("sprite", "fal", createHandler(1).handler);
      registry.register("sprite", "acme", createHandler(3).handler);
      const api = createSpriteApi(createTestCtx({ registry, config: { defaultProvider: "acme" } }));

      expect(api.estimate(request)).toEqual({ usd: 3 });
    });
  });

  describe("providers", () => {
    it('delegates to registry.providers("sprite") in registration order', () => {
      const registry = createFakeRegistry();
      registry.register("sprite", "fal", createHandler().handler);
      registry.register("sprite", "acme", createHandler().handler);
      registry.register("image", "fal", {});
      const api = createSpriteApi(createTestCtx({ registry }));

      expect(api.providers()).toEqual(["fal", "acme"]);
    });

    it("returns an empty array when nothing is registered", () => {
      expect(createSpriteApi(createTestCtx()).providers()).toEqual([]);
    });
  });

  describe("unknown provider", () => {
    it("lists the registered providers", async () => {
      const api = apiWith(createHandler().handler, "fal");

      await expect(api.generate(request, { provider: "acme" })).rejects.toThrow(
        '[ai] No sprite provider named "acme" is registered.\n  Available: fal.'
      );
    });

    it('uses "none" when no providers are registered', () => {
      const api = createSpriteApi(createTestCtx());

      expect(() => api.estimate(request)).toThrow(
        '[ai] No sprite provider named "fal" is registered.\n  Available: none.'
      );
    });

    it("treats a malformed registration as unknown", async () => {
      const api = apiWith({ estimate: () => ({ usd: 0 }) }, "broken");

      await expect(api.generate(request, { provider: "broken" })).rejects.toThrow(
        '[ai] No sprite provider named "broken" is registered.\n  Available: broken.'
      );
    });

    it("does not read another task's registration", () => {
      const registry = createFakeRegistry();
      registry.register("image", "fal", createHandler().handler);
      const api = createSpriteApi(createTestCtx({ registry }));

      expect(() => api.estimate(request)).toThrow(
        '[ai] No sprite provider named "fal" is registered.\n  Available: none.'
      );
    });
  });

  describe("types: SpriteApi", () => {
    it("generate accepts SpriteRequest and resolves SpriteResult", () => {
      expectTypeOf<SpriteApi["generate"]>().parameter(0).toEqualTypeOf<SpriteRequest>();
      expectTypeOf<SpriteApi["generate"]>().returns.resolves.toEqualTypeOf<SpriteResult>();
      expect(typeof createSpriteApi(createTestCtx()).generate).toBe("function");
    });

    it("estimate returns { usd: number }", () => {
      expectTypeOf<SpriteApi["estimate"]>().returns.toEqualTypeOf<{ usd: number }>();
      expect(typeof createSpriteApi(createTestCtx()).estimate).toBe("function");
    });

    it("providers returns string[]", () => {
      expectTypeOf<SpriteApi["providers"]>().returns.toEqualTypeOf<string[]>();
      expect(createSpriteApi(createTestCtx()).providers()).toEqual([]);
    });

    it("model is a required string and the result is always a PNG", () => {
      expectTypeOf<SpriteRequest["model"]>().toEqualTypeOf<string>();
      expectTypeOf<SpriteResult["mimeType"]>().toEqualTypeOf<"image/png">();
      // @ts-expect-error -- missing required "model" field
      const bad: SpriteRequest = { source: request.source };
      expect(bad).toBeDefined();
    });

    it("execute is required on a handler", () => {
      // @ts-expect-error -- a sprite handler has no submit/poll form
      const bad: SpriteHandler = { estimate: () => ({ usd: 0 }) };
      expect(bad).toBeDefined();
    });
  });
});
