import { describe, expect, expectTypeOf, it } from "vitest";
import { createVoiceoverApi, mergePackParameters } from "../../api";
import { narrationPack } from "../../packs/narration";
import type {
  Config,
  RegistryApi,
  VoiceoverApi,
  VoiceoverContext,
  VoiceoverHandler,
  VoiceoverRequest,
  VoiceoverResult
} from "../../types";

// ---------------------------------------------------------------------------
// Standard tier: voiceover plugin (task contract owner + one-off facade)
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

/** Builds a mock voiceover context (config + empty state + no-op emit + a fake registry). */
function createTestCtx(overrides?: {
  config?: Partial<Config>;
  registry?: RegistryApi;
}): VoiceoverContext {
  const config: Config = {
    defaultProvider: "elevenlabs",
    defaultFormat: "mp3",
    ...overrides?.config
  };
  const registry = overrides?.registry ?? createFakeRegistry();
  // voiceover declares no events — emit is a typed no-op returning undefined.
  return { config, state: {}, emit: () => undefined, require: () => registry };
}

/** Reference audio bytes returned by the reference handler, for exact round-trip assertions. */
const referenceAudio = new Uint8Array([1, 2, 3]);

/** Reference handler used to prove generate()/estimate() round-trip through a real handler. */
const referenceHandler: VoiceoverHandler = {
  estimate: request => ({ usd: request.text.length * 0.0001 }),
  execute: async request => ({
    audio: referenceAudio,
    mimeType: "audio/mpeg",
    costUsd: request.text.length * 0.0001,
    meta: { characters: request.text.length }
  })
};

/** Malformed registration missing `execute` — used to prove the audited cast guard, not a crash. */
const malformedHandler = { estimate: () => ({ usd: 0 }) };

describe("standard tier: voiceover plugin", () => {
  // -------------------------------------------------------------------------
  // api: audited cast site (spec/09 R9)
  // -------------------------------------------------------------------------

  describe("api: audited cast site", () => {
    it("throws a descriptive error (not a crash) when a registered value has a malformed shape", async () => {
      const registry = createFakeRegistry();
      registry.register("voiceover", "broken", malformedHandler);
      const api = createVoiceoverApi(createTestCtx({ registry }));

      await expect(
        api.generate({ text: "hi", voice: "v1" }, { provider: "broken" })
      ).rejects.toThrow('[ai] No voiceover provider named "broken" is registered.');
    });

    it("throws a descriptive error when nothing is registered under the resolved provider", async () => {
      const api = createVoiceoverApi(createTestCtx());

      await expect(
        api.generate({ text: "hi", voice: "v1" }, { provider: "ghost" })
      ).rejects.toThrow('[ai] No voiceover provider named "ghost" is registered.');
    });

    it("resolves and executes a well-formed registered handler", async () => {
      const registry = createFakeRegistry();
      registry.register("voiceover", "elevenlabs", referenceHandler);
      const api = createVoiceoverApi(createTestCtx({ registry }));

      const result = await api.generate({ text: "hi", voice: "v1" }, { provider: "elevenlabs" });

      expect(result.audio).toBe(referenceAudio);
      expect(result.mimeType).toBe("audio/mpeg");
    });
  });

  // -------------------------------------------------------------------------
  // api: default-provider fallback
  // -------------------------------------------------------------------------

  describe("api: default-provider fallback", () => {
    it("uses config.defaultProvider when opts.provider is omitted", async () => {
      const registry = createFakeRegistry();
      registry.register("voiceover", "elevenlabs", referenceHandler);
      const api = createVoiceoverApi(
        createTestCtx({ registry, config: { defaultProvider: "elevenlabs" } })
      );

      const result = await api.generate({ text: "hi", voice: "v1" });

      expect(result.mimeType).toBe("audio/mpeg");
    });

    it("prefers opts.provider over config.defaultProvider when both are given", async () => {
      const registry = createFakeRegistry();
      registry.register("voiceover", "openai", referenceHandler);
      registry.register("voiceover", "elevenlabs", malformedHandler);
      const api = createVoiceoverApi(
        createTestCtx({ registry, config: { defaultProvider: "elevenlabs" } })
      );

      const result = await api.generate({ text: "hi", voice: "v1" }, { provider: "openai" });

      expect(result.mimeType).toBe("audio/mpeg");
    });
  });

  // -------------------------------------------------------------------------
  // api: unknown-provider error format (exact two-line text)
  // -------------------------------------------------------------------------

  describe("api: unknown-provider error format", () => {
    it("lists the registered providers, comma-separated", async () => {
      const registry = createFakeRegistry();
      registry.register("voiceover", "elevenlabs", referenceHandler);
      registry.register("voiceover", "openai", referenceHandler);
      const api = createVoiceoverApi(createTestCtx({ registry }));

      await expect(api.generate({ text: "hi", voice: "v1" }, { provider: "acme" })).rejects.toThrow(
        '[ai] No voiceover provider named "acme" is registered.\n  Available: elevenlabs, openai.'
      );
    });

    it('uses "none" when no providers are registered for the task', async () => {
      const api = createVoiceoverApi(createTestCtx());

      await expect(api.generate({ text: "hi", voice: "v1" }, { provider: "acme" })).rejects.toThrow(
        '[ai] No voiceover provider named "acme" is registered.\n  Available: none.'
      );
    });

    it("matches the exact pinned two-line format", async () => {
      const api = createVoiceoverApi(createTestCtx());

      await expect(api.generate({ text: "hi", voice: "v1" }, { provider: "acme" })).rejects.toThrow(
        /^\[ai] No voiceover provider named "acme" is registered\.\n {2}.+\.$/
      );
    });

    it("estimate() throws the same pinned format for an unknown provider", () => {
      const api = createVoiceoverApi(createTestCtx());

      expect(() => api.estimate({ text: "hi", voice: "v1" }, { provider: "acme" })).toThrow(
        '[ai] No voiceover provider named "acme" is registered.\n  Available: none.'
      );
    });
  });

  // -------------------------------------------------------------------------
  // api: pack merge precedence (request params beat pack values)
  // -------------------------------------------------------------------------

  describe("api: pack merge precedence", () => {
    it("layers request params on top of pack defaults", () => {
      const pack = {
        name: "test-pack",
        version: "1.0.0",
        values: { elevenlabs: { stability: 0.5, style: "calm" } }
      } as const;

      const merged = mergePackParameters(pack, "elevenlabs", { stability: 0.9 });

      expect(merged).toEqual({ stability: 0.9, style: "calm" });
    });

    it("falls back to an empty object when the pack has no values for the provider", () => {
      const merged = mergePackParameters(narrationPack, "elevenlabs", { voice: "warm" });

      expect(merged).toEqual({ voice: "warm" });
    });

    it("returns just the pack defaults when the request has no params", () => {
      const pack = {
        name: "test-pack",
        version: "1.0.0",
        values: { elevenlabs: { stability: 0.5 } }
      } as const;

      const merged = mergePackParameters(pack, "elevenlabs", undefined);

      expect(merged).toEqual({ stability: 0.5 });
    });
  });

  // -------------------------------------------------------------------------
  // api: estimate delegates to the handler
  // -------------------------------------------------------------------------

  describe("api: estimate delegates to the handler", () => {
    it("returns the resolved handler's own estimate, without calling execute", () => {
      let executeCalled = false;
      const handler: VoiceoverHandler = {
        estimate: request => ({ usd: request.text.length * 0.0002 }),
        execute: async () => {
          executeCalled = true;
          return { audio: referenceAudio, mimeType: "audio/mpeg", costUsd: 0 };
        }
      };
      const registry = createFakeRegistry();
      registry.register("voiceover", "elevenlabs", handler);
      const api = createVoiceoverApi(createTestCtx({ registry }));

      const result = api.estimate({ text: "hello", voice: "v1" }, { provider: "elevenlabs" });

      expect(result).toEqual({ usd: 0.001 });
      expect(executeCalled).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // api: providers()
  // -------------------------------------------------------------------------

  describe("api: providers", () => {
    it('delegates to registry.providers("voiceover")', () => {
      const registry = createFakeRegistry();
      registry.register("voiceover", "elevenlabs", referenceHandler);
      registry.register("voiceover", "openai", referenceHandler);
      const api = createVoiceoverApi(createTestCtx({ registry }));

      expect(api.providers()).toEqual(["elevenlabs", "openai"]);
    });

    it("returns an empty array when no voiceover providers are registered", () => {
      const api = createVoiceoverApi(createTestCtx());

      expect(api.providers()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // types: VoiceoverApi signatures
  // -------------------------------------------------------------------------

  describe("types: VoiceoverApi", () => {
    it("generate accepts VoiceoverRequest and returns Promise<VoiceoverResult>", () => {
      expectTypeOf<VoiceoverApi["generate"]>().parameter(0).toEqualTypeOf<VoiceoverRequest>();
      expectTypeOf<VoiceoverApi["generate"]>().returns.resolves.toEqualTypeOf<VoiceoverResult>();
    });

    it("estimate accepts VoiceoverRequest and returns { usd: number }", () => {
      expectTypeOf<VoiceoverApi["estimate"]>().parameter(0).toEqualTypeOf<VoiceoverRequest>();
      expectTypeOf<VoiceoverApi["estimate"]>().returns.toEqualTypeOf<{ usd: number }>();
    });

    it("providers returns string[]", () => {
      expectTypeOf<VoiceoverApi["providers"]>().returns.toEqualTypeOf<string[]>();
    });

    it("rejects a request literal missing the required text field", () => {
      // @ts-expect-error -- missing required "text" field
      const bad: VoiceoverRequest = { voice: "v1" };
      expect(bad).toBeDefined();
    });
  });
});
