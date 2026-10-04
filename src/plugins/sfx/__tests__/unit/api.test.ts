import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createSfxApi, isSfxHandler } from "../../api";
import type {
  Config,
  RegistryApi,
  SfxApi,
  SfxContext,
  SfxHandler,
  SfxRequest,
  SfxResult
} from "../../types";

// ---------------------------------------------------------------------------
// Standard tier: sfx plugin (task contract owner + one-off facade)
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
 * Builds a mock sfx context (config + empty state + no-op emit + a fake registry).
 *
 * @param overrides - Optional config overrides and registry.
 * @param overrides.config - Config fields to override.
 * @param overrides.registry - Registry to hand out from `require`.
 * @returns The mock context.
 */
function createTestCtx(overrides?: {
  config?: Partial<Config>;
  registry?: RegistryApi;
}): SfxContext {
  const config: Config = { defaultProvider: "elevenlabs", ...overrides?.config };
  const registry = overrides?.registry ?? createFakeRegistry();
  return { config, state: {}, emit: () => undefined, require: () => registry };
}

/**
 * Registers `handler` under "sfx"/`provider` and returns a facade over it.
 *
 * @param handler - The value to register.
 * @param provider - The provider name.
 * @returns The sfx facade.
 */
function apiWith(handler: unknown, provider = "elevenlabs"): SfxApi {
  const registry = createFakeRegistry();
  registry.register("sfx", provider, handler);
  return createSfxApi(createTestCtx({ registry }));
}

const audioBytes = new Uint8Array([73, 68, 51]);
const request: SfxRequest = {
  prompt: "sword hit, metallic",
  model: "eleven_text_to_sound_v2",
  durationMs: 800
};
const hitResult: SfxResult = {
  audio: audioBytes,
  mimeType: "audio/mpeg",
  costUsd: 0.12,
  meta: { requestId: "r1" }
};

/**
 * A well-formed handler with spied `estimate` and `execute`.
 *
 * @param usd - The estimate it returns.
 * @returns The handler and its spies.
 */
function createHandler(usd = 0.12) {
  const estimate = vi.fn(() => ({ usd }));
  const execute = vi.fn(async () => hitResult);
  const handler: SfxHandler = { estimate, execute };
  return { handler, estimate, execute };
}

describe("standard tier: sfx plugin", () => {
  describe("isSfxHandler guard", () => {
    it("accepts estimate + execute", () => {
      expect(isSfxHandler(createHandler().handler)).toBe(true);
    });

    it("rejects a handler without execute", () => {
      expect(isSfxHandler({ estimate: () => ({ usd: 0 }) })).toBe(false);
    });

    it("rejects a submit/poll-only handler", () => {
      expect(
        isSfxHandler({
          estimate: () => ({ usd: 0 }),
          submit: async () => ({ jobId: "j" }),
          poll: async () => ({ state: "pending" })
        })
      ).toBe(false);
    });

    it("rejects a handler without estimate", () => {
      expect(isSfxHandler({ execute: async () => hitResult })).toBe(false);
    });

    it("rejects non-objects", () => {
      expect(isSfxHandler(undefined)).toBe(false);
      expect(isSfxHandler("elevenlabs")).toBe(false);
    });
  });

  describe("generate", () => {
    it("calls the default provider's execute once and returns its result", async () => {
      const { handler, execute } = createHandler();
      const api = apiWith(handler);

      const result = await api.generate(request);

      expect(result).toBe(hitResult);
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

    it("honors the provider override", async () => {
      const registry = createFakeRegistry();
      const eleven = createHandler();
      const fal = createHandler();
      registry.register("sfx", "elevenlabs", eleven.handler);
      registry.register("sfx", "fal", fal.handler);
      const api = createSfxApi(createTestCtx({ registry }));

      await api.generate(request, { provider: "fal" });

      expect(fal.execute).toHaveBeenCalledTimes(1);
      expect(eleven.execute).not.toHaveBeenCalled();
    });

    it("rejects with the handler's error as-is", async () => {
      const error = new Error("quota exceeded");
      const api = apiWith({
        estimate: () => ({ usd: 0 }),
        execute: async () => {
          throw error;
        }
      });

      await expect(api.generate(request)).rejects.toBe(error);
    });
  });

  describe("estimate", () => {
    it("returns the handler's estimate without generating", () => {
      const { handler, estimate, execute } = createHandler(0.24);
      const api = apiWith(handler);

      expect(api.estimate(request)).toEqual({ usd: 0.24 });
      expect(estimate).toHaveBeenCalledWith(request);
      expect(execute).not.toHaveBeenCalled();
    });

    it("honors the provider override", () => {
      const registry = createFakeRegistry();
      registry.register("sfx", "elevenlabs", createHandler(1).handler);
      registry.register("sfx", "fal", createHandler(2).handler);
      const api = createSfxApi(createTestCtx({ registry }));

      expect(api.estimate(request, { provider: "fal" })).toEqual({ usd: 2 });
    });

    it("uses config.defaultProvider when the caller names none", () => {
      const registry = createFakeRegistry();
      registry.register("sfx", "elevenlabs", createHandler(1).handler);
      registry.register("sfx", "acme", createHandler(3).handler);
      const api = createSfxApi(createTestCtx({ registry, config: { defaultProvider: "acme" } }));

      expect(api.estimate(request)).toEqual({ usd: 3 });
    });
  });

  describe("providers", () => {
    it('delegates to registry.providers("sfx") in registration order', () => {
      const registry = createFakeRegistry();
      registry.register("sfx", "elevenlabs", createHandler().handler);
      registry.register("sfx", "fal", createHandler().handler);
      registry.register("music", "acme", {});
      const api = createSfxApi(createTestCtx({ registry }));

      expect(api.providers()).toEqual(["elevenlabs", "fal"]);
    });

    it("returns an empty array when nothing is registered", () => {
      expect(createSfxApi(createTestCtx()).providers()).toEqual([]);
    });
  });

  describe("unknown provider", () => {
    it("lists the registered providers", async () => {
      const api = apiWith(createHandler().handler, "elevenlabs");

      await expect(api.generate(request, { provider: "acme" })).rejects.toThrow(
        '[ai] No sfx provider named "acme" is registered.\n  Available: elevenlabs.'
      );
    });

    it('uses "none" when no providers are registered', () => {
      const api = createSfxApi(createTestCtx());

      expect(() => api.estimate(request)).toThrow(
        '[ai] No sfx provider named "elevenlabs" is registered.\n  Available: none.'
      );
    });

    it("treats a malformed registration as unknown", async () => {
      const api = apiWith({ estimate: () => ({ usd: 0 }) }, "broken");

      await expect(api.generate(request, { provider: "broken" })).rejects.toThrow(
        '[ai] No sfx provider named "broken" is registered.\n  Available: broken.'
      );
    });

    it("does not read another task's registration", () => {
      const registry = createFakeRegistry();
      registry.register("music", "elevenlabs", createHandler().handler);
      const api = createSfxApi(createTestCtx({ registry }));

      expect(() => api.estimate(request)).toThrow(
        '[ai] No sfx provider named "elevenlabs" is registered.\n  Available: none.'
      );
    });
  });

  describe("types: SfxApi", () => {
    it("generate accepts SfxRequest and resolves SfxResult", () => {
      expectTypeOf<SfxApi["generate"]>().parameter(0).toEqualTypeOf<SfxRequest>();
      expectTypeOf<SfxApi["generate"]>().returns.resolves.toEqualTypeOf<SfxResult>();
      expect(typeof createSfxApi(createTestCtx()).generate).toBe("function");
    });

    it("estimate returns { usd: number }", () => {
      expectTypeOf<SfxApi["estimate"]>().returns.toEqualTypeOf<{ usd: number }>();
      expect(typeof createSfxApi(createTestCtx()).estimate).toBe("function");
    });

    it("providers returns string[]", () => {
      expectTypeOf<SfxApi["providers"]>().returns.toEqualTypeOf<string[]>();
      expect(createSfxApi(createTestCtx()).providers()).toEqual([]);
    });

    it("model is a required string and the result is always mp3", () => {
      expectTypeOf<SfxRequest["model"]>().toEqualTypeOf<string>();
      expectTypeOf<SfxResult["mimeType"]>().toEqualTypeOf<"audio/mpeg">();
      // @ts-expect-error -- missing required "model" field
      const bad: SfxRequest = { prompt: "coin pickup" };
      expect(bad).toBeDefined();
    });

    it("execute is required on the handler", () => {
      // @ts-expect-error -- an sfx handler has no submit/poll form
      const bad: SfxHandler = { estimate: () => ({ usd: 0 }) };
      expect(isSfxHandler(bad)).toBe(false);
    });
  });
});
