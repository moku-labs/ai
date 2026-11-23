import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createUpscaleApi, isUpscaleHandler } from "../../api";
import type {
  Config,
  RegistryApi,
  UpscaleApi,
  UpscaleContext,
  UpscaleEstimateRequest,
  UpscaleHandler,
  UpscaleJobPoll,
  UpscaleRequest,
  UpscaleResult
} from "../../types";

// ---------------------------------------------------------------------------
// Standard tier: upscale plugin (task contract owner + one-off facade)
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
 * Builds a mock upscale context (config + empty state + no-op emit + a fake registry).
 *
 * @param overrides - Optional config overrides and registry.
 * @param overrides.config - Config fields to override.
 * @param overrides.registry - Registry to hand out from `require`.
 * @returns The mock context.
 */
function createTestCtx(overrides?: {
  config?: Partial<Config>;
  registry?: RegistryApi;
}): UpscaleContext {
  const config: Config = { defaultProvider: "fal", pollIntervalMs: 0, ...overrides?.config };
  const registry = overrides?.registry ?? createFakeRegistry();
  return { config, state: {}, emit: () => undefined, require: () => registry };
}

/**
 * Registers `handler` under "upscale"/`provider` and returns a facade over it.
 *
 * @param handler - The value to register.
 * @param provider - The provider name.
 * @param config - Config fields to override.
 * @returns The upscale facade.
 */
function apiWith(handler: unknown, provider = "fal", config?: Partial<Config>): UpscaleApi {
  const registry = createFakeRegistry();
  registry.register("upscale", provider, handler);
  return createUpscaleApi(createTestCtx({ registry, ...(config === undefined ? {} : { config }) }));
}

const videoBytes = new Uint8Array([0, 0, 0, 24]);
const request: UpscaleRequest = {
  video: { path: "out/ep01.mp4", mimeType: "video/mp4", hash: "ab12" },
  model: "starlight-fast-2",
  factor: 1.5,
  seconds: 62.4
};
const doneResult: UpscaleResult = {
  video: videoBytes,
  mimeType: "video/mp4",
  costUsd: 3.744,
  meta: { requestId: "r1" }
};

/**
 * A submit/poll-only handler whose poll answers from `answers` in order.
 *
 * @param answers - Poll answers, consumed front to back; then "pending" forever.
 * @returns The handler and its spies.
 */
function createJobHandler(answers: UpscaleJobPoll[]) {
  const submit = vi.fn(async () => ({ jobId: "job-1" }));
  const poll = vi.fn(async (): Promise<UpscaleJobPoll> => answers.shift() ?? { state: "pending" });
  const handler: UpscaleHandler = { estimate: () => ({ usd: 3.744 }), submit, poll };
  return { handler, submit, poll };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("standard tier: upscale plugin", () => {
  describe("isUpscaleHandler guard", () => {
    it("accepts execute-only and submit+poll-only handlers", () => {
      expect(
        isUpscaleHandler({ estimate: () => ({ usd: 0 }), execute: async () => doneResult })
      ).toBe(true);
      expect(isUpscaleHandler(createJobHandler([]).handler)).toBe(true);
    });

    // Bug caught: a malformed provider passes the guard and crashes later with "not a function".
    it("refuses an estimate-only handler, a half job pair, and non-objects", () => {
      expect(isUpscaleHandler({ estimate: () => ({ usd: 0 }) })).toBe(false);
      expect(isUpscaleHandler({ estimate: () => ({ usd: 0 }), submit: async () => ({}) })).toBe(
        false
      );
      expect(isUpscaleHandler({ estimate: () => ({ usd: 0 }), poll: async () => ({}) })).toBe(
        false
      );
      expect(isUpscaleHandler({ execute: async () => doneResult })).toBe(false);
      expect(isUpscaleHandler(undefined)).toBe(false);
    });
  });

  describe("generate: execute path", () => {
    // Bug caught: the facade prefers submit/poll over execute, double-submitting a paid job.
    it("calls execute once and never submits", async () => {
      const execute = vi.fn(async () => doneResult);
      const submit = vi.fn(async () => ({ jobId: "never" }));
      const poll = vi.fn(async (): Promise<UpscaleJobPoll> => ({ state: "pending" }));
      const api = apiWith({ estimate: () => ({ usd: 0 }), execute, submit, poll });

      const result = await api.generate(request);

      expect(result).toBe(doneResult);
      expect(execute).toHaveBeenCalledWith(request, {});
      expect(submit).not.toHaveBeenCalled();
    });

    // Bug caught: the signal is dropped, so aborting a run cannot cancel the provider call.
    it("forwards the abort signal to execute", async () => {
      const execute = vi.fn(async () => doneResult);
      const api = apiWith({ estimate: () => ({ usd: 0 }), execute });
      const controller = new AbortController();

      await api.generate(request, { signal: controller.signal });

      expect(execute).toHaveBeenCalledWith(request, { signal: controller.signal });
    });
  });

  describe("generate: submit/poll path", () => {
    // Bug caught: the state discriminant leaks into the result, or the job is submitted twice.
    it("submits once, polls until done, and strips the state field", async () => {
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

    // Bug caught: the poll loop ignores config.pollIntervalMs and hammers the provider.
    it("waits config.pollIntervalMs between polls", async () => {
      vi.useFakeTimers();
      const { handler, poll } = createJobHandler([
        { state: "pending" },
        { state: "done", video: videoBytes, mimeType: "video/mp4", costUsd: 3.744 }
      ]);
      const api = apiWith(handler, "fal", { pollIntervalMs: 5000 });

      const pending = api.generate(request);
      await vi.advanceTimersByTimeAsync(0);
      expect(poll).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4999);
      expect(poll).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toStrictEqual({
        video: videoBytes,
        mimeType: "video/mp4",
        costUsd: 3.744
      });
      expect(poll).toHaveBeenCalledTimes(2);
    });

    // Bug caught: a failed job is swallowed or wrapped, so the provider's error type is lost.
    it("throws the failed poll's error as-is", async () => {
      const error = new Error("content policy");
      const { handler } = createJobHandler([{ state: "pending" }, { state: "failed", error }]);
      const api = apiWith(handler);

      await expect(api.generate(request)).rejects.toBe(error);
    });

    // Bug caught: abort during the wait leaves the timer running and rejects with the wrong reason.
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

    // Bug caught: a signal aborted before the wait still sleeps a full interval, then polls again.
    it("rejects without polling again when the signal is already aborted before the wait", async () => {
      const controller = new AbortController();
      const reason = new Error("early");
      const submit = vi.fn(async () => {
        controller.abort(reason);
        return { jobId: "job-1" };
      });
      const poll = vi.fn(async (): Promise<UpscaleJobPoll> => ({ state: "pending" }));
      const api = apiWith({ estimate: () => ({ usd: 0 }), submit, poll });

      await expect(api.generate(request, { signal: controller.signal })).rejects.toBe(reason);
      expect(poll).toHaveBeenCalledTimes(1);
    });
  });

  describe("estimate", () => {
    // Bug caught: the facade resolves the video or alters the request, so the runner
    // gate and the facade price different inputs.
    it("passes an unresolved $ref request to the handler unchanged, without generating", () => {
      const estimate = vi.fn(() => ({ usd: 0.2 }));
      const submit = vi.fn();
      const api = apiWith({ estimate, submit, poll: vi.fn() });
      const unresolved: UpscaleEstimateRequest = {
        video: { $ref: "clean" },
        model: "proteus",
        factor: 1.5,
        seconds: 10
      };

      expect(api.estimate(unresolved)).toEqual({ usd: 0.2 });

      expect(estimate).toHaveBeenCalledWith(unresolved);
      expect(submit).not.toHaveBeenCalled();
    });

    // Bug caught: opts.provider ignored, or defaultProvider ignored when no override is given.
    it("honors the provider override and falls back to config.defaultProvider", () => {
      const registry = createFakeRegistry();
      registry.register("upscale", "fal", { estimate: () => ({ usd: 1 }), execute: vi.fn() });
      registry.register("upscale", "acme", { estimate: () => ({ usd: 3 }), execute: vi.fn() });

      const byOverride = createUpscaleApi(createTestCtx({ registry }));
      expect(byOverride.estimate(request, { provider: "acme" })).toEqual({ usd: 3 });

      const byDefault = createUpscaleApi(
        createTestCtx({ registry, config: { defaultProvider: "acme" } })
      );
      expect(byDefault.estimate(request)).toEqual({ usd: 3 });
    });
  });

  describe("providers", () => {
    // Bug caught: providers() reads another task's list (the key is not "upscale").
    it('lists only registry.providers("upscale"), in registration order', () => {
      const registry = createFakeRegistry();
      registry.register("upscale", "fal", createJobHandler([]).handler);
      registry.register("upscale", "acme", createJobHandler([]).handler);
      registry.register("video", "fal", {});
      const api = createUpscaleApi(createTestCtx({ registry }));

      expect(api.providers()).toEqual(["fal", "acme"]);
    });
  });

  describe("unknown provider", () => {
    // Bug caught: the error omits the available names, so a typo in `provider:` is not fixable.
    it("names the provider and lists the registered ones", async () => {
      const api = apiWith(createJobHandler([]).handler, "fal");

      await expect(api.generate(request, { provider: "acme" })).rejects.toThrow(
        '[ai] No upscale provider named "acme" is registered.\n  Available: fal.'
      );
    });

    it('prints "none" when no providers are registered', () => {
      const api = createUpscaleApi(createTestCtx());

      expect(() => api.estimate(request)).toThrow(
        '[ai] No upscale provider named "fal" is registered.\n  Available: none.'
      );
    });

    // Bug caught: a malformed registration is used instead of reported.
    it("treats a malformed registration as unknown", async () => {
      const api = apiWith({ estimate: () => ({ usd: 0 }) }, "broken");

      await expect(api.generate(request, { provider: "broken" })).rejects.toThrow(
        '[ai] No upscale provider named "broken" is registered.\n  Available: broken.'
      );
    });
  });

  describe("types", () => {
    // Bug caught: generate accepts an unresolved reference, which no provider can read.
    it("generate needs a resolved video and a model; estimate also accepts $ref and $file", () => {
      // @ts-expect-error -- missing required "model" field
      const noModel: UpscaleRequest = { video: request.video, factor: 1.5, seconds: 10 };
      // @ts-expect-error -- an unresolved { $ref } video is not an UpscaleFile
      const unresolved: UpscaleRequest = { ...request, video: { $ref: "clean" } };
      const estimable: UpscaleEstimateRequest = { ...request, video: { $file: "a.mp4" } };

      expect([noModel, unresolved, estimable]).toHaveLength(3);
      expectTypeOf<UpscaleApi["generate"]>().parameter(0).toEqualTypeOf<UpscaleRequest>();
      expectTypeOf<UpscaleApi["estimate"]>().parameter(0).toEqualTypeOf<UpscaleEstimateRequest>();
      expectTypeOf<UpscaleRequest>().toExtend<UpscaleEstimateRequest>();
    });
  });
});
