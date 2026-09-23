import { describe, expect, expectTypeOf, it } from "vitest";
import { createImageApi } from "../../api";
import type {
  Config,
  ImageApi,
  ImageContext,
  ImageHandler,
  ImageRequest,
  ImageResult,
  RegistryApi
} from "../../types";

// ---------------------------------------------------------------------------
// Standard tier: image plugin (task contract owner + one-off facade)
// ---------------------------------------------------------------------------

/** In-memory fake mirroring registry's real register/resolve/providers/tasks behavior. */
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

/** Builds a mock image context (config + empty state + no-op emit + a fake registry). */
function createTestCtx(overrides?: {
  config?: Partial<Config>;
  registry?: RegistryApi;
}): ImageContext {
  const config: Config = { defaultProvider: "codex", ...overrides?.config };
  const registry = overrides?.registry ?? createFakeRegistry();
  // image declares no events — emit is a typed no-op returning undefined.
  return { config, state: {}, emit: () => undefined, require: () => registry };
}

/** Reference image bytes returned by the reference handler, for exact round-trip assertions. */
const referenceImage = new Uint8Array([137, 80, 78, 71]);

/** Records every execute() call so tests can assert request and signal passthrough. */
type RecordingHandler = ImageHandler & {
  calls: { request: ImageRequest; opts: { signal?: AbortSignal } }[];
};

/**
 * Builds a handler that records execute() calls and prices by prompt length.
 *
 * @param mimeType - MIME type the handler reports.
 * @returns A recording handler.
 */
function createRecordingHandler(mimeType = "image/png"): RecordingHandler {
  const calls: RecordingHandler["calls"] = [];
  return {
    calls,
    estimate: request => ({ usd: request.prompt.length * 0.001 }),
    execute: async (request, opts) => {
      calls.push({ request, opts });
      return { image: referenceImage, mimeType, costUsd: 0.04, meta: { model: request.model } };
    }
  };
}

/** Malformed registration missing `execute` — proves the audited cast guard, not a crash. */
const malformedHandler = { estimate: () => ({ usd: 0 }) };

describe("standard tier: image plugin", () => {
  describe("api: generate", () => {
    it("delegates to handler.execute with the caller's request unchanged", async () => {
      const handler = createRecordingHandler();
      const registry = createFakeRegistry();
      registry.register("image", "codex", handler);
      const api = createImageApi(createTestCtx({ registry }));
      const request: ImageRequest = { prompt: "a patisserie at night", aspect: "9:16" };

      const result = await api.generate(request);

      expect(result.image).toBe(referenceImage);
      expect(result.mimeType).toBe("image/png");
      expect(result.costUsd).toBe(0.04);
      expect(handler.calls).toHaveLength(1);
      expect(handler.calls[0]?.request).toEqual(request);
    });

    it("passes the abort signal through to handler.execute", async () => {
      const handler = createRecordingHandler();
      const registry = createFakeRegistry();
      registry.register("image", "codex", handler);
      const api = createImageApi(createTestCtx({ registry }));
      const controller = new AbortController();

      await api.generate({ prompt: "p" }, { signal: controller.signal });

      expect(handler.calls[0]?.opts.signal).toBe(controller.signal);
    });

    it("passes an empty opts object when no signal is given", async () => {
      const handler = createRecordingHandler();
      const registry = createFakeRegistry();
      registry.register("image", "codex", handler);
      const api = createImageApi(createTestCtx({ registry }));

      await api.generate({ prompt: "p" });

      expect(handler.calls[0]?.opts).toEqual({});
    });
  });

  describe("api: provider resolution", () => {
    it("uses config.defaultProvider when opts.provider is omitted", async () => {
      const codex = createRecordingHandler("image/png");
      const fal = createRecordingHandler("image/webp");
      const registry = createFakeRegistry();
      registry.register("image", "codex", codex);
      registry.register("image", "fal", fal);
      const api = createImageApi(createTestCtx({ registry, config: { defaultProvider: "fal" } }));

      const result = await api.generate({ prompt: "p" });

      expect(result.mimeType).toBe("image/webp");
      expect(codex.calls).toHaveLength(0);
    });

    it("prefers opts.provider over config.defaultProvider", async () => {
      const fal = createRecordingHandler("image/webp");
      const registry = createFakeRegistry();
      registry.register("image", "codex", malformedHandler);
      registry.register("image", "fal", fal);
      const api = createImageApi(createTestCtx({ registry }));

      const result = await api.generate({ prompt: "p" }, { provider: "fal" });

      expect(result.mimeType).toBe("image/webp");
    });
  });

  describe("api: unknown-provider error", () => {
    it("lists the registered providers, comma-separated", async () => {
      const registry = createFakeRegistry();
      registry.register("image", "codex", createRecordingHandler());
      registry.register("image", "fal", createRecordingHandler());
      const api = createImageApi(createTestCtx({ registry }));

      await expect(api.generate({ prompt: "p" }, { provider: "acme" })).rejects.toThrow(
        '[ai] No image provider named "acme" is registered.\n  Available: codex, fal.'
      );
    });

    it('uses "none" when no image providers are registered', async () => {
      const api = createImageApi(createTestCtx());

      await expect(api.generate({ prompt: "p" })).rejects.toThrow(
        '[ai] No image provider named "codex" is registered.\n  Available: none.'
      );
    });

    it("throws the same error for a registered but malformed handler", async () => {
      const registry = createFakeRegistry();
      registry.register("image", "broken", malformedHandler);
      const api = createImageApi(createTestCtx({ registry }));

      await expect(api.generate({ prompt: "p" }, { provider: "broken" })).rejects.toThrow(
        '[ai] No image provider named "broken" is registered.'
      );
    });

    it("rejects an empty registration without crashing", async () => {
      const registry = createFakeRegistry();
      registry.register("image", "codex", undefined);
      const api = createImageApi(createTestCtx({ registry }));

      await expect(api.generate({ prompt: "p" })).rejects.toThrow(
        /^\[ai] No image provider named "codex" is registered\.\n {2}.+\.$/
      );
    });

    it("estimate() throws the same pinned format for an unknown provider", () => {
      const api = createImageApi(createTestCtx());

      expect(() => api.estimate({ prompt: "p" }, { provider: "acme" })).toThrow(
        '[ai] No image provider named "acme" is registered.\n  Available: none.'
      );
    });
  });

  describe("api: estimate", () => {
    it("returns the resolved handler's own estimate without calling execute", () => {
      const handler = createRecordingHandler();
      const registry = createFakeRegistry();
      registry.register("image", "codex", handler);
      const api = createImageApi(createTestCtx({ registry }));

      const result = api.estimate({ prompt: "hello" });

      expect(result).toEqual({ usd: 0.005 });
      expect(handler.calls).toHaveLength(0);
    });

    it("honors opts.provider", () => {
      const registry = createFakeRegistry();
      registry.register("image", "codex", createRecordingHandler());
      registry.register("image", "fal", {
        estimate: () => ({ usd: 0.5 }),
        execute: async () => ({ image: referenceImage, mimeType: "image/png", costUsd: 0.5 })
      });
      const api = createImageApi(createTestCtx({ registry }));

      expect(api.estimate({ prompt: "p" }, { provider: "fal" })).toEqual({ usd: 0.5 });
    });
  });

  describe("api: providers", () => {
    it("lists registered image providers in registration order", () => {
      const registry = createFakeRegistry();
      registry.register("image", "codex", createRecordingHandler());
      registry.register("image", "fal", createRecordingHandler());
      const api = createImageApi(createTestCtx({ registry }));

      expect(api.providers()).toEqual(["codex", "fal"]);
    });

    it("keeps registration order whatever the configured default is", () => {
      const registry = createFakeRegistry();
      registry.register("image", "codex", createRecordingHandler());
      registry.register("image", "fal", createRecordingHandler());
      const api = createImageApi(createTestCtx({ registry, config: { defaultProvider: "fal" } }));

      expect(api.providers()).toEqual(["codex", "fal"]);
    });

    it("ignores providers registered under other tasks", () => {
      const registry = createFakeRegistry();
      registry.register("voiceover", "elevenlabs", {});
      const api = createImageApi(createTestCtx({ registry }));

      expect(api.providers()).toEqual([]);
    });
  });

  describe("types: ImageApi", () => {
    it("generate accepts ImageRequest and returns Promise<ImageResult>", () => {
      expectTypeOf<ImageApi["generate"]>().parameter(0).toEqualTypeOf<ImageRequest>();
      expectTypeOf<ImageApi["generate"]>().returns.resolves.toEqualTypeOf<ImageResult>();
    });

    it("estimate returns { usd: number }", () => {
      expectTypeOf<ImageApi["estimate"]>().returns.toEqualTypeOf<{ usd: number }>();
    });

    it("rejects a request literal missing the required prompt field", () => {
      // @ts-expect-error -- missing required "prompt" field
      const bad: ImageRequest = { aspect: "9:16" };
      expect(bad).toBeDefined();
    });
  });
});
