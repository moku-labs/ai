import { describe, expect, it } from "vitest";
import { createTranslateApi } from "../../api";
import type { Config, RegistryApi, TranslateContext, TranslateHandler } from "../../types";

// ---------------------------------------------------------------------------
// Unit test: createTranslateApi (mock context, no kernel)
// ---------------------------------------------------------------------------

/**
 * Builds a fake `registry` API backed by a plain Map, matching `RegistryApi`
 * exactly — used to control exactly what `ctx.require(registryPlugin)`
 * resolves without booting the real kernel.
 */
function createFakeRegistry(initialProviders: Record<string, unknown>): RegistryApi {
  const handlers = new Map<string, unknown>(Object.entries(initialProviders));
  return {
    register: (_task: string, provider: string, handler: unknown): void => {
      handlers.set(provider, handler);
    },
    resolve: (_task: string, provider: string): unknown => handlers.get(provider),
    providers: (): string[] => [...handlers.keys()],
    tasks: (): string[] => (handlers.size > 0 ? ["translate"] : [])
  };
}

/** A well-formed TranslateHandler fixture: prefixes text, cost proportional to length. */
const openaiHandler: TranslateHandler = {
  estimate: request => ({ usd: request.text.length * 0.000_01 }),
  execute: async request => ({ text: `es:${request.text}`, costUsd: 0.0004 })
};

/**
 * Builds a mock translate context: plugin config, empty state (translate is
 * stateless), a typed no-op emit (translate declares no events), and
 * `require` bound to a fake registry.
 */
function createTestCtx(overrides?: {
  config?: Partial<Config>;
  registry?: RegistryApi;
}): TranslateContext {
  const config: Config = { defaultProvider: "openai", ...overrides?.config };
  const registry = overrides?.registry ?? createFakeRegistry({ openai: openaiHandler });
  return {
    config,
    state: {},
    emit: () => undefined,
    require: () => registry
  };
}

describe("translate unit: createTranslateApi", () => {
  describe("generate", () => {
    it("falls back to the configured default provider when none is requested", async () => {
      const ctx = createTestCtx();
      const api = createTranslateApi(ctx);

      const result = await api.generate({ text: "Hello", targetLang: "es" });

      expect(result.text).toBe("es:Hello");
    });

    it("uses the explicitly requested provider over the configured default", async () => {
      const frenchHandler: TranslateHandler = {
        estimate: () => ({ usd: 1 }),
        execute: async request => ({ text: `fr:${request.text}`, costUsd: 1 })
      };
      const registry = createFakeRegistry({ openai: openaiHandler, elevenlabs: frenchHandler });
      const ctx = createTestCtx({ registry });
      const api = createTranslateApi(ctx);

      const result = await api.generate(
        { text: "Hi", targetLang: "fr" },
        { provider: "elevenlabs" }
      );

      expect(result.text).toBe("fr:Hi");
    });

    it("throws the exact two-line error for an unregistered provider", async () => {
      const ctx = createTestCtx({ registry: createFakeRegistry({ openai: openaiHandler }) });
      const api = createTranslateApi(ctx);

      await expect(
        api.generate({ text: "Hi", targetLang: "es" }, { provider: "missing" })
      ).rejects.toThrow(
        '[ai] No translate provider named "missing" is registered.\n  Available: openai.'
      );
    });

    it('reports "none" as available when the registry has no translate providers', async () => {
      const ctx = createTestCtx({ registry: createFakeRegistry({}) });
      const api = createTranslateApi(ctx);

      await expect(
        api.generate({ text: "Hi", targetLang: "es" }, { provider: "missing" })
      ).rejects.toThrow(
        '[ai] No translate provider named "missing" is registered.\n  Available: none.'
      );
    });

    it("throws a descriptive Error (not a crash) for a malformed registered value", async () => {
      const registry = createFakeRegistry({ broken: { estimate: "not-a-function" } });
      const ctx = createTestCtx({ registry });
      const api = createTranslateApi(ctx);

      let caught: unknown;
      try {
        await api.generate({ text: "Hi", targetLang: "es" }, { provider: "broken" });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(TypeError);
      expect((caught as Error).message).toContain("does not implement TranslateHandler");
    });

    it("forwards the abort signal to the resolved handler", async () => {
      const controller = new AbortController();
      let receivedSignal: AbortSignal | undefined;
      const signalCapturingHandler: TranslateHandler = {
        estimate: () => ({ usd: 0 }),
        execute: async (request, opts) => {
          receivedSignal = opts.signal;
          return { text: request.text, costUsd: 0 };
        }
      };
      const ctx = createTestCtx({
        registry: createFakeRegistry({ openai: signalCapturingHandler })
      });
      const api = createTranslateApi(ctx);

      await api.generate({ text: "Hi", targetLang: "es" }, { signal: controller.signal });

      expect(receivedSignal).toBe(controller.signal);
    });
  });

  describe("estimate", () => {
    it("delegates to the resolved handler's estimate() without executing", () => {
      const ctx = createTestCtx();
      const api = createTranslateApi(ctx);

      const result = api.estimate({ text: "Hello", targetLang: "es" });

      expect(result).toEqual({ usd: "Hello".length * 0.000_01 });
    });

    it("throws the exact two-line error for an unregistered provider", () => {
      const ctx = createTestCtx({ registry: createFakeRegistry({ openai: openaiHandler }) });
      const api = createTranslateApi(ctx);

      expect(() => api.estimate({ text: "Hi", targetLang: "es" }, { provider: "missing" })).toThrow(
        '[ai] No translate provider named "missing" is registered.\n  Available: openai.'
      );
    });
  });

  describe("providers", () => {
    it("lists registered translate providers in registration order", () => {
      const registry = createFakeRegistry({ openai: openaiHandler, elevenlabs: openaiHandler });
      const ctx = createTestCtx({ registry });
      const api = createTranslateApi(ctx);

      expect(api.providers()).toEqual(["openai", "elevenlabs"]);
    });

    it("returns an empty array when nothing is registered", () => {
      const ctx = createTestCtx({ registry: createFakeRegistry({}) });
      const api = createTranslateApi(ctx);

      expect(api.providers()).toEqual([]);
    });
  });
});
