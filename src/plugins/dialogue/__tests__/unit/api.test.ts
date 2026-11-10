import { describe, expect, it, vi } from "vitest";
import { createDialogueApi, isDialogueHandler } from "../../api";
import type {
  Config,
  DialogueApi,
  DialogueContext,
  DialogueHandler,
  DialogueRequest,
  DialogueResult,
  RegistryApi
} from "../../types";

// ---------------------------------------------------------------------------
// Standard tier: dialogue plugin (task contract owner + one-off facade)
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
 * Builds a mock dialogue context (config + empty state + no-op emit + a fake registry).
 *
 * @param overrides - Optional config overrides and registry.
 * @param overrides.config - Config fields to override.
 * @param overrides.registry - Registry to hand out from `require`.
 * @returns The mock context.
 */
function createTestCtx(overrides?: {
  config?: Partial<Config>;
  registry?: RegistryApi;
}): DialogueContext {
  const config: Config = { defaultProvider: "elevenlabs", ...overrides?.config };
  const registry = overrides?.registry ?? createFakeRegistry();
  return { config, state: {}, emit: () => undefined, require: () => registry };
}

/**
 * Registers `handler` under "dialogue"/`provider` and returns a facade over it.
 *
 * @param handler - The value to register.
 * @param provider - The provider name.
 * @returns The dialogue facade.
 */
function apiWith(handler: unknown, provider = "elevenlabs"): DialogueApi {
  const registry = createFakeRegistry();
  registry.register("dialogue", provider, handler);
  return createDialogueApi(createTestCtx({ registry }));
}

const audioBytes = new Uint8Array([73, 68, 51]);
const request: DialogueRequest = {
  model: "eleven_v4",
  lines: [
    { id: "signAlice", text: "[tense] No.", voice: "v1" },
    { id: "signDaniel", text: "[bitterly] Yes.", voice: "v2" }
  ]
};
const sceneResult: DialogueResult = {
  audio: audioBytes,
  mimeType: "audio/mpeg",
  costUsd: 0.4,
  outputs: [
    { bytes: audioBytes, mimeType: "audio/mpeg" },
    { bytes: audioBytes, mimeType: "audio/mpeg", name: "signAlice" }
  ],
  lines: [{ index: 0, id: "signAlice", startMs: 0, endMs: 1200 }]
};

/**
 * A well-formed handler with spied `estimate` and `execute`.
 *
 * @param usd - The estimate it returns.
 * @returns The handler and its spies.
 */
function createHandler(usd = 0.4) {
  const estimate = vi.fn(() => ({ usd }));
  const execute = vi.fn(
    async (_request: DialogueRequest, _opts: { signal?: AbortSignal }) => sceneResult
  );
  const handler: DialogueHandler = { estimate, execute };
  return { handler, estimate, execute };
}

describe("standard tier: dialogue plugin", () => {
  describe("isDialogueHandler guard", () => {
    it("accepts estimate + execute", () => {
      expect(isDialogueHandler(createHandler().handler)).toBe(true);
    });

    it("rejects a handler without execute", () => {
      expect(isDialogueHandler({ estimate: () => ({ usd: 0 }) })).toBe(false);
    });

    it("rejects a handler without estimate", () => {
      expect(isDialogueHandler({ execute: async () => sceneResult })).toBe(false);
    });

    it("rejects non-objects", () => {
      expect(isDialogueHandler(undefined)).toBe(false);
      expect(isDialogueHandler("elevenlabs")).toBe(false);
    });
  });

  describe("generate", () => {
    it("calls the default provider's execute once and returns its result", async () => {
      const { handler, execute } = createHandler();
      const api = apiWith(handler);

      const result = await api.generate(request);

      expect(result).toBe(sceneResult);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(request, {});
    });

    it("leaves the signal key out of the options when none is given", async () => {
      const { handler, execute } = createHandler();
      const api = apiWith(handler);

      await api.generate(request);

      // toHaveBeenCalledWith treats { signal: undefined } as {}, so check the key itself.
      const options = execute.mock.calls[0]?.[1];
      expect(options).toBeDefined();
      expect(Object.keys(options ?? {})).toEqual([]);
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
      const other = createHandler();
      registry.register("dialogue", "elevenlabs", eleven.handler);
      registry.register("dialogue", "acme", other.handler);
      const api = createDialogueApi(createTestCtx({ registry }));

      await api.generate(request, { provider: "acme" });

      expect(other.execute).toHaveBeenCalledTimes(1);
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
      registry.register("dialogue", "elevenlabs", createHandler(1).handler);
      registry.register("dialogue", "acme", createHandler(2).handler);
      const api = createDialogueApi(createTestCtx({ registry }));

      expect(api.estimate(request, { provider: "acme" })).toEqual({ usd: 2 });
    });

    it("uses config.defaultProvider when the caller names none", () => {
      const registry = createFakeRegistry();
      registry.register("dialogue", "elevenlabs", createHandler(1).handler);
      registry.register("dialogue", "acme", createHandler(3).handler);
      const api = createDialogueApi(
        createTestCtx({ registry, config: { defaultProvider: "acme" } })
      );

      expect(api.estimate(request)).toEqual({ usd: 3 });
    });
  });

  describe("providers", () => {
    it('delegates to registry.providers("dialogue") in registration order', () => {
      const registry = createFakeRegistry();
      registry.register("dialogue", "elevenlabs", createHandler().handler);
      registry.register("dialogue", "acme", createHandler().handler);
      registry.register("sfx", "fal", {});
      const api = createDialogueApi(createTestCtx({ registry }));

      expect(api.providers()).toEqual(["elevenlabs", "acme"]);
    });
  });

  describe("unknown provider", () => {
    it("lists every registered provider, comma separated", async () => {
      const registry = createFakeRegistry();
      registry.register("dialogue", "elevenlabs", createHandler().handler);
      registry.register("dialogue", "beta", createHandler().handler);
      const api = createDialogueApi(createTestCtx({ registry }));

      await expect(api.generate(request, { provider: "acme" })).rejects.toThrow(
        '[ai] No dialogue provider named "acme" is registered.\n  Available: elevenlabs, beta.'
      );
    });

    it('uses "none" when no providers are registered', () => {
      const api = createDialogueApi(createTestCtx());

      expect(() => api.estimate(request)).toThrow(
        '[ai] No dialogue provider named "elevenlabs" is registered.\n  Available: none.'
      );
    });

    it("treats a malformed registration as unknown", async () => {
      const api = apiWith({ estimate: () => ({ usd: 0 }) }, "broken");

      await expect(api.generate(request, { provider: "broken" })).rejects.toThrow(
        '[ai] No dialogue provider named "broken" is registered.\n  Available: broken.'
      );
    });

    it("does not read another task's registration", () => {
      const registry = createFakeRegistry();
      registry.register("sfx", "elevenlabs", createHandler().handler);
      const api = createDialogueApi(createTestCtx({ registry }));

      expect(() => api.estimate(request)).toThrow(
        '[ai] No dialogue provider named "elevenlabs" is registered.\n  Available: none.'
      );
    });
  });
});
