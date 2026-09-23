import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createVideoApi, isVideoHandler } from "../../api";
import type {
  Config,
  RegistryApi,
  VideoApi,
  VideoContext,
  VideoHandler,
  VideoJobPoll,
  VideoRequest,
  VideoResult
} from "../../types";

// ---------------------------------------------------------------------------
// Standard tier: video plugin (task contract owner + one-off facade)
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

/** Builds a mock video context (config + empty state + no-op emit + a fake registry). */
function createTestCtx(overrides?: {
  config?: Partial<Config>;
  registry?: RegistryApi;
}): VideoContext {
  const config: Config = { defaultProvider: "fal", pollIntervalMs: 0, ...overrides?.config };
  const registry = overrides?.registry ?? createFakeRegistry();
  return { config, state: {}, emit: () => undefined, require: () => registry };
}

/** Registers `handler` under "video"/`provider` and returns a facade over it. */
function apiWith(handler: unknown, provider = "fal", config?: Partial<Config>): VideoApi {
  const registry = createFakeRegistry();
  registry.register("video", provider, handler);
  return createVideoApi(createTestCtx({ registry, ...(config === undefined ? {} : { config }) }));
}

const clipBytes = new Uint8Array([7, 8, 9]);
const request: VideoRequest = { model: "minimax-h3", prompt: "slow push-in", seconds: 5 };
const doneResult: VideoResult = {
  video: clipBytes,
  mimeType: "video/mp4",
  costUsd: 0.25,
  meta: { requestId: "r1" }
};

/** A submit/poll-only handler whose poll answers from `answers` in order. */
function createJobHandler(answers: VideoJobPoll[]) {
  const submit = vi.fn(async () => ({ jobId: "job-1" }));
  const poll = vi.fn(async (): Promise<VideoJobPoll> => answers.shift() ?? { state: "pending" });
  const handler: VideoHandler = { estimate: () => ({ usd: 0.25 }), submit, poll };
  return { handler, submit, poll };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("standard tier: video plugin", () => {
  describe("isVideoHandler guard", () => {
    it("accepts estimate + execute", () => {
      expect(
        isVideoHandler({ estimate: () => ({ usd: 0 }), execute: async () => doneResult })
      ).toBe(true);
    });

    it("accepts estimate + submit + poll", () => {
      expect(isVideoHandler(createJobHandler([]).handler)).toBe(true);
    });

    it("rejects submit without poll", () => {
      expect(isVideoHandler({ estimate: () => ({ usd: 0 }), submit: async () => ({}) })).toBe(
        false
      );
    });

    it("rejects a handler without estimate", () => {
      expect(isVideoHandler({ execute: async () => doneResult })).toBe(false);
    });

    it("rejects non-objects", () => {
      expect(isVideoHandler(undefined)).toBe(false);
      expect(isVideoHandler("fal")).toBe(false);
    });
  });

  describe("generate: execute path", () => {
    it("calls execute once and returns its result", async () => {
      const execute = vi.fn(async () => doneResult);
      const submit = vi.fn(async () => ({ jobId: "never" }));
      const poll = vi.fn(async (): Promise<VideoJobPoll> => ({ state: "pending" }));
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
        { state: "done", video: clipBytes, mimeType: "video/mp4", costUsd: 0.25 }
      ]);
      const api = apiWith(handler, "fal", { pollIntervalMs: 5000 });

      const pending = api.generate(request);
      await vi.advanceTimersByTimeAsync(0);
      expect(poll).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4999);
      expect(poll).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toStrictEqual({
        video: clipBytes,
        mimeType: "video/mp4",
        costUsd: 0.25
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
      const poll = vi.fn(async (): Promise<VideoJobPoll> => ({ state: "pending" }));
      const api = apiWith({ estimate: () => ({ usd: 0 }), submit, poll });

      await expect(api.generate(request, { signal: controller.signal })).rejects.toBe(reason);
      expect(poll).toHaveBeenCalledTimes(1);
    });
  });

  describe("estimate", () => {
    it("returns the handler's estimate without generating", () => {
      const { handler, submit } = createJobHandler([]);
      const api = apiWith(handler);

      expect(api.estimate(request)).toEqual({ usd: 0.25 });
      expect(submit).not.toHaveBeenCalled();
    });

    it("honors the provider override", () => {
      const registry = createFakeRegistry();
      registry.register("video", "fal", { estimate: () => ({ usd: 1 }), execute: vi.fn() });
      registry.register("video", "other", { estimate: () => ({ usd: 2 }), execute: vi.fn() });
      const api = createVideoApi(createTestCtx({ registry }));

      expect(api.estimate(request, { provider: "other" })).toEqual({ usd: 2 });
    });
  });

  describe("providers", () => {
    it('delegates to registry.providers("video") in registration order', () => {
      const registry = createFakeRegistry();
      registry.register("video", "fal", createJobHandler([]).handler);
      registry.register("video", "acme", createJobHandler([]).handler);
      registry.register("image", "codex", {});
      const api = createVideoApi(createTestCtx({ registry }));

      expect(api.providers()).toEqual(["fal", "acme"]);
    });

    it("returns an empty array when nothing is registered", () => {
      expect(createVideoApi(createTestCtx()).providers()).toEqual([]);
    });
  });

  describe("unknown provider", () => {
    it("lists the registered providers", async () => {
      const api = apiWith(createJobHandler([]).handler, "fal");

      await expect(api.generate(request, { provider: "acme" })).rejects.toThrow(
        '[ai] No video provider named "acme" is registered.\n  Available: fal.'
      );
    });

    it('uses "none" when no providers are registered', () => {
      const api = createVideoApi(createTestCtx());

      expect(() => api.estimate(request)).toThrow(
        '[ai] No video provider named "fal" is registered.\n  Available: none.'
      );
    });

    it("treats a malformed registration as unknown", async () => {
      const api = apiWith({ estimate: () => ({ usd: 0 }) }, "broken");

      await expect(api.generate(request, { provider: "broken" })).rejects.toThrow(
        '[ai] No video provider named "broken" is registered.\n  Available: broken.'
      );
    });
  });

  describe("types: VideoApi", () => {
    it("generate accepts VideoRequest and resolves VideoResult", () => {
      expectTypeOf<VideoApi["generate"]>().parameter(0).toEqualTypeOf<VideoRequest>();
      expectTypeOf<VideoApi["generate"]>().returns.resolves.toEqualTypeOf<VideoResult>();
    });

    it("estimate returns { usd: number }", () => {
      expectTypeOf<VideoApi["estimate"]>().returns.toEqualTypeOf<{ usd: number }>();
    });

    it("rejects a request without a model", () => {
      // @ts-expect-error -- missing required "model" field
      const bad: VideoRequest = { prompt: "push-in" };
      expect(bad).toBeDefined();
    });
  });
});
