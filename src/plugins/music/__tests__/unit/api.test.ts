import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createMusicApi, isMusicHandler } from "../../api";
import type {
  Config,
  MusicApi,
  MusicChunk,
  MusicContext,
  MusicHandler,
  MusicJobPoll,
  MusicRequest,
  MusicResult,
  RegistryApi
} from "../../types";

// ---------------------------------------------------------------------------
// Standard tier: music plugin (task contract owner + one-off facade)
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
 * Builds a mock music context (config + empty state + no-op emit + a fake registry).
 *
 * @param overrides - Optional config overrides and registry.
 * @param overrides.config - Config fields to override.
 * @param overrides.registry - Registry to hand out from `require`.
 * @returns The mock context.
 */
function createTestCtx(overrides?: {
  config?: Partial<Config>;
  registry?: RegistryApi;
}): MusicContext {
  const config: Config = { defaultProvider: "fal", pollIntervalMs: 0, ...overrides?.config };
  const registry = overrides?.registry ?? createFakeRegistry();
  return { config, state: {}, emit: () => undefined, require: () => registry };
}

/**
 * Registers `handler` under "music"/`provider` and returns a facade over it.
 *
 * @param handler - The value to register.
 * @param provider - The provider name.
 * @param config - Config fields to override.
 * @returns The music facade.
 */
function apiWith(handler: unknown, provider = "fal", config?: Partial<Config>): MusicApi {
  const registry = createFakeRegistry();
  registry.register("music", provider, handler);
  return createMusicApi(createTestCtx({ registry, ...(config === undefined ? {} : { config }) }));
}

const audioBytes = new Uint8Array([73, 68, 51]);
const request: MusicRequest = {
  prompt: "tense synth pulse",
  model: "elevenlabs-music-v2.5",
  lengthMs: 60_000
};
const doneResult: MusicResult = {
  audio: audioBytes,
  mimeType: "audio/mpeg",
  costUsd: 0.8,
  meta: { requestId: "r1" }
};

/**
 * A submit/poll-only handler whose poll answers from `answers` in order.
 *
 * @param answers - Poll answers, consumed front to back; then "pending" forever.
 * @returns The handler and its spies.
 */
function createJobHandler(answers: MusicJobPoll[]) {
  const submit = vi.fn(async () => ({ jobId: "job-1" }));
  const poll = vi.fn(async (): Promise<MusicJobPoll> => answers.shift() ?? { state: "pending" });
  const handler: MusicHandler = { estimate: () => ({ usd: 0.8 }), submit, poll };
  return { handler, submit, poll };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("standard tier: music plugin", () => {
  describe("isMusicHandler guard", () => {
    it("accepts estimate + execute", () => {
      expect(
        isMusicHandler({ estimate: () => ({ usd: 0 }), execute: async () => doneResult })
      ).toBe(true);
    });

    it("accepts estimate + submit + poll", () => {
      expect(isMusicHandler(createJobHandler([]).handler)).toBe(true);
    });

    it("rejects submit without poll", () => {
      expect(isMusicHandler({ estimate: () => ({ usd: 0 }), submit: async () => ({}) })).toBe(
        false
      );
    });

    it("rejects poll without submit", () => {
      expect(isMusicHandler({ estimate: () => ({ usd: 0 }), poll: async () => ({}) })).toBe(false);
    });

    it("rejects a handler without estimate", () => {
      expect(isMusicHandler({ execute: async () => doneResult })).toBe(false);
    });

    it("rejects non-objects", () => {
      expect(isMusicHandler(undefined)).toBe(false);
      expect(isMusicHandler("fal")).toBe(false);
    });
  });

  describe("generate: execute path", () => {
    it("calls execute once and returns its result", async () => {
      const execute = vi.fn(async () => doneResult);
      const submit = vi.fn(async () => ({ jobId: "never" }));
      const poll = vi.fn(async (): Promise<MusicJobPoll> => ({ state: "pending" }));
      const api = apiWith({ estimate: () => ({ usd: 0 }), execute, submit, poll });

      const result = await api.generate(request);

      expect(result).toBe(doneResult);
      expect(execute).toHaveBeenCalledWith(request, {});
      expect(submit).not.toHaveBeenCalled();
    });

    it("forwards the abort signal to execute", async () => {
      const execute = vi.fn(async () => doneResult);
      const api = apiWith({ estimate: () => ({ usd: 0 }), execute });
      const controller = new AbortController();

      await api.generate(request, { signal: controller.signal });

      expect(execute).toHaveBeenCalledWith(request, { signal: controller.signal });
    });
  });

  describe("generate: submit/poll path", () => {
    it("submits once, polls pending twice then done, and strips the state field", async () => {
      const { handler, submit, poll } = createJobHandler([
        { state: "pending" },
        { state: "pending" },
        { state: "done", ...doneResult }
      ]);
      const api = apiWith(handler);

      const result = await api.generate(request);

      expect(result).toEqual(doneResult);
      expect(result).not.toHaveProperty("state");
      expect(submit).toHaveBeenCalledTimes(1);
      expect(poll).toHaveBeenCalledTimes(3);
      expect(poll).toHaveBeenCalledWith("job-1", request, {});
    });

    it("waits config.pollIntervalMs between polls", async () => {
      vi.useFakeTimers();
      const { handler, poll } = createJobHandler([
        { state: "pending" },
        { state: "done", audio: audioBytes, mimeType: "audio/mpeg", costUsd: 0.8 }
      ]);
      const api = apiWith(handler, "fal", { pollIntervalMs: 5000 });

      const pending = api.generate(request);
      await vi.advanceTimersByTimeAsync(0);
      expect(poll).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4999);
      expect(poll).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toStrictEqual({
        audio: audioBytes,
        mimeType: "audio/mpeg",
        costUsd: 0.8
      });
      expect(poll).toHaveBeenCalledTimes(2);
    });

    it("throws the failed poll's error as-is", async () => {
      const error = new Error("content policy");
      const { handler } = createJobHandler([{ state: "pending" }, { state: "failed", error }]);
      const api = apiWith(handler);

      await expect(api.generate(request)).rejects.toBe(error);
    });

    it("rejects with the signal's reason when aborted during the poll wait", async () => {
      vi.useFakeTimers();
      const { handler, poll } = createJobHandler([]);
      const api = apiWith(handler, "fal", { pollIntervalMs: 5000 });
      const controller = new AbortController();
      const reason = new Error("stop");

      const pending = api.generate(request, { signal: controller.signal });
      const outcome = expect(pending).rejects.toBe(reason);
      await vi.advanceTimersByTimeAsync(1000);
      controller.abort(reason);
      await outcome;

      expect(poll).toHaveBeenCalledTimes(1);
      expect(poll).toHaveBeenCalledWith("job-1", request, { signal: controller.signal });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects without polling again when the signal is already aborted before the wait", async () => {
      const controller = new AbortController();
      const reason = new Error("early");
      const submit = vi.fn(async () => {
        controller.abort(reason);
        return { jobId: "job-1" };
      });
      const poll = vi.fn(async (): Promise<MusicJobPoll> => ({ state: "pending" }));
      const api = apiWith({ estimate: () => ({ usd: 0 }), submit, poll });

      await expect(api.generate(request, { signal: controller.signal })).rejects.toBe(reason);
      expect(poll).toHaveBeenCalledTimes(1);
    });
  });

  describe("estimate", () => {
    it("returns the handler's estimate without generating", () => {
      const { handler, submit } = createJobHandler([]);
      const api = apiWith(handler);

      expect(api.estimate(request)).toEqual({ usd: 0.8 });
      expect(submit).not.toHaveBeenCalled();
    });

    it("passes the request to the handler unchanged", () => {
      const estimate = vi.fn(() => ({ usd: 0.2 }));
      const api = apiWith({ estimate, execute: vi.fn() });

      api.estimate(request);

      expect(estimate).toHaveBeenCalledWith(request);
    });

    it("honors the provider override", () => {
      const registry = createFakeRegistry();
      registry.register("music", "fal", { estimate: () => ({ usd: 1 }), execute: vi.fn() });
      registry.register("music", "other", { estimate: () => ({ usd: 2 }), execute: vi.fn() });
      const api = createMusicApi(createTestCtx({ registry }));

      expect(api.estimate(request, { provider: "other" })).toEqual({ usd: 2 });
    });

    it("uses config.defaultProvider when the caller names none", () => {
      const registry = createFakeRegistry();
      registry.register("music", "fal", { estimate: () => ({ usd: 1 }), execute: vi.fn() });
      registry.register("music", "acme", { estimate: () => ({ usd: 3 }), execute: vi.fn() });
      const api = createMusicApi(createTestCtx({ registry, config: { defaultProvider: "acme" } }));

      expect(api.estimate(request)).toEqual({ usd: 3 });
    });
  });

  describe("providers", () => {
    it('delegates to registry.providers("music") in registration order', () => {
      const registry = createFakeRegistry();
      registry.register("music", "fal", createJobHandler([]).handler);
      registry.register("music", "acme", createJobHandler([]).handler);
      registry.register("video", "fal", {});
      const api = createMusicApi(createTestCtx({ registry }));

      expect(api.providers()).toEqual(["fal", "acme"]);
    });

    it("returns an empty array when nothing is registered", () => {
      expect(createMusicApi(createTestCtx()).providers()).toEqual([]);
    });
  });

  describe("unknown provider", () => {
    it("lists the registered providers", async () => {
      const api = apiWith(createJobHandler([]).handler, "fal");

      await expect(api.generate(request, { provider: "acme" })).rejects.toThrow(
        '[ai] No music provider named "acme" is registered.\n  Available: fal.'
      );
    });

    it('uses "none" when no providers are registered', () => {
      const api = createMusicApi(createTestCtx());

      expect(() => api.estimate(request)).toThrow(
        '[ai] No music provider named "fal" is registered.\n  Available: none.'
      );
    });

    it("treats a malformed registration as unknown", async () => {
      const api = apiWith({ estimate: () => ({ usd: 0 }) }, "broken");

      await expect(api.generate(request, { provider: "broken" })).rejects.toThrow(
        '[ai] No music provider named "broken" is registered.\n  Available: broken.'
      );
    });

    it("does not read another task's registration", () => {
      const registry = createFakeRegistry();
      registry.register("video", "fal", { estimate: () => ({ usd: 1 }), execute: vi.fn() });
      const api = createMusicApi(createTestCtx({ registry }));

      expect(() => api.estimate(request)).toThrow(
        '[ai] No music provider named "fal" is registered.\n  Available: none.'
      );
    });
  });

  describe("types: MusicApi", () => {
    it("generate accepts MusicRequest and resolves MusicResult", () => {
      expectTypeOf<MusicApi["generate"]>().parameter(0).toEqualTypeOf<MusicRequest>();
      expectTypeOf<MusicApi["generate"]>().returns.resolves.toEqualTypeOf<MusicResult>();
      expect(typeof createMusicApi(createTestCtx()).generate).toBe("function");
    });

    it("estimate returns { usd: number }", () => {
      expectTypeOf<MusicApi["estimate"]>().returns.toEqualTypeOf<{ usd: number }>();
      expect(typeof createMusicApi(createTestCtx()).estimate).toBe("function");
    });

    it("providers returns string[]", () => {
      expectTypeOf<MusicApi["providers"]>().returns.toEqualTypeOf<string[]>();
      expect(createMusicApi(createTestCtx()).providers()).toEqual([]);
    });

    it("model is a required string", () => {
      expectTypeOf<MusicRequest["model"]>().toEqualTypeOf<string>();
      // @ts-expect-error -- missing required "model" field
      const bad: MusicRequest = { prompt: "tense synth", lengthMs: 30_000 };
      expect(bad).toBeDefined();
    });

    it("accepts an optional composition plan of chunks", () => {
      const chunks: MusicChunk[] = [
        { text: "intro", durationMs: 20_000, styles: ["ambient"] },
        { text: "build", durationMs: 40_000, styles: ["synthwave"], avoid: ["vocals"] }
      ];
      const planned: MusicRequest = { ...request, chunks, seed: 7 };

      expectTypeOf<MusicRequest["chunks"]>().toEqualTypeOf<MusicChunk[] | undefined>();
      expect(planned.chunks).toHaveLength(2);
    });
  });
});
