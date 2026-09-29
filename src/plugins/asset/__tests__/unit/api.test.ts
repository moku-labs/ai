import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { registryPlugin } from "../../../registry";
import { createAssetApi, isAssetHandler } from "../../api";
import { ASSET_MIME, encodeAssetRecord } from "../../contract";
import type {
  AssetApi,
  AssetContext,
  AssetHandler,
  AssetJobPoll,
  AssetRecord,
  AssetRequest,
  Config,
  RegistryApi
} from "../../types";

// ---------------------------------------------------------------------------
// Standard tier: asset plugin (task contract owner + one-off facade)
// ---------------------------------------------------------------------------

/**
 * A real registry: the registry plugin in a bare app. Nothing is started, so
 * the journal and store core plugins open no files.
 *
 * @returns The live `app.registry` API.
 * @example
 * ```ts
 * createRegistry().providers("asset"); // => []
 * ```
 */
function createRegistry(): RegistryApi {
  return createCore(coreConfig, { plugins: [registryPlugin] }).createApp().registry;
}

/**
 * Builds a mock asset context over a real registry.
 *
 * @param registry - The registry the facade resolves handlers from.
 * @param config - Config overrides.
 * @returns The asset context.
 * @example
 * ```ts
 * const ctx = createTestCtx(createRegistry(), { pollIntervalMs: 0 });
 * ```
 */
function createTestCtx(registry: RegistryApi, config?: Partial<Config>): AssetContext {
  const resolved: Config = { defaultProvider: "ark", pollIntervalMs: 0, ...config };
  return { config: resolved, state: {}, emit: () => undefined, require: () => registry };
}

/**
 * Registers `handler` under "asset"/`provider` in a real registry and returns a facade over it.
 *
 * @param handler - Any value; the facade's guard decides whether it is a handler.
 * @param provider - Provider name.
 * @param config - Config overrides.
 * @returns The asset API.
 * @example
 * ```ts
 * const api = apiWith(createJobHandler([]).handler);
 * ```
 */
function apiWith(handler: unknown, provider = "ark", config?: Partial<Config>): AssetApi {
  const registry = createRegistry();
  registry.register("asset", provider, handler);
  return createAssetApi(createTestCtx(registry, config));
}

const image = { path: "refs/mira.png", mimeType: "image/png", hash: "a".repeat(64) };
const request: AssetRequest = { image, url: "https://cdn.example/mira.png" };
const record: AssetRecord = {
  assetId: "asset-20260929-a1",
  provider: "ark",
  account: "3f9a0c1b2d4e",
  groupId: "group-7",
  registeredAt: 1_790_000_000_000
};
const done: AssetJobPoll = {
  state: "done",
  body: encodeAssetRecord(record),
  mimeType: ASSET_MIME,
  costUsd: 0,
  meta: { assetId: record.assetId, account: record.account }
};

/**
 * A submit/poll handler whose poll answers from `answers` in order, then pending.
 *
 * @param answers - Poll answers.
 * @returns The handler and its spies.
 * @example
 * ```ts
 * const { handler, submit } = createJobHandler([done]);
 * ```
 */
function createJobHandler(answers: AssetJobPoll[]) {
  const submit = vi.fn(async () => ({ jobId: "job-1" }));
  const poll = vi.fn(async (): Promise<AssetJobPoll> => answers.shift() ?? { state: "pending" });
  const estimate = vi.fn(() => ({ usd: 0 }));
  const handler: AssetHandler = { estimate, submit, poll };
  return { handler, submit, poll, estimate };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("standard tier: asset plugin", () => {
  describe("isAssetHandler guard", () => {
    it("accepts estimate + submit + poll", () => {
      expect(isAssetHandler(createJobHandler([]).handler)).toBe(true);
    });

    it("rejects a handler without poll", () => {
      expect(isAssetHandler({ estimate: () => ({ usd: 0 }), submit: async () => ({}) })).toBe(
        false
      );
    });

    it("rejects a handler without estimate", () => {
      const { submit, poll } = createJobHandler([]);
      expect(isAssetHandler({ submit, poll })).toBe(false);
    });

    it("rejects an execute-only handler", () => {
      expect(isAssetHandler({ estimate: () => ({ usd: 0 }), execute: async () => done })).toBe(
        false
      );
    });

    it("rejects non-objects", () => {
      expect(isAssetHandler(undefined)).toBe(false);
      expect(isAssetHandler("ark")).toBe(false);
    });
  });

  describe("register", () => {
    it("submits once, polls until done, and returns the parsed record", async () => {
      const { handler, submit, poll } = createJobHandler([
        { state: "pending" },
        { state: "pending" },
        done
      ]);
      const api = apiWith(handler);

      const result = await api.register(request);

      expect(result).toStrictEqual(record);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledWith(request, {});
      expect(poll).toHaveBeenCalledTimes(3);
      expect(poll).toHaveBeenCalledWith("job-1", request, {});
    });

    it("waits config.pollIntervalMs between polls", async () => {
      vi.useFakeTimers();
      const { handler, poll } = createJobHandler([{ state: "pending" }, done]);
      const api = apiWith(handler, "ark", { pollIntervalMs: 3000 });

      const pending = api.register(request);
      await vi.advanceTimersByTimeAsync(0);
      expect(poll).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2999);
      expect(poll).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toStrictEqual(record);
      expect(poll).toHaveBeenCalledTimes(2);
    });

    it("rethrows the failed poll's error as-is", async () => {
      const error = Object.assign(new Error("face mismatch"), { kind: "content-policy" });
      const { handler } = createJobHandler([{ state: "pending" }, { state: "failed", error }]);
      const api = apiWith(handler);

      await expect(api.register(request)).rejects.toBe(error);
    });

    it("rejects with the two-line parse error when the done body is not a record", async () => {
      const { handler } = createJobHandler([
        { ...done, body: new TextEncoder().encode('{"assetId":"a"}') }
      ]);
      const api = apiWith(handler);

      await expect(api.register(request)).rejects.toThrow(
        '[ai] Not an asset record: missing "provider".\n  Expected JSON with assetId, provider, account, groupId, registeredAt.'
      );
    });

    it("rejects with the signal's reason when aborted during the poll wait", async () => {
      vi.useFakeTimers();
      const { handler, poll } = createJobHandler([]);
      const api = apiWith(handler, "ark", { pollIntervalMs: 3000 });
      const controller = new AbortController();
      const reason = new Error("stop");

      const pending = api.register(request, { signal: controller.signal });
      const outcome = expect(pending).rejects.toBe(reason);
      await vi.advanceTimersByTimeAsync(1000);
      controller.abort(reason);
      await outcome;

      expect(poll).toHaveBeenCalledTimes(1);
      expect(poll).toHaveBeenCalledWith("job-1", request, { signal: controller.signal });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects without waiting when the signal is already aborted before the wait", async () => {
      const controller = new AbortController();
      const reason = new Error("early");
      const submit = vi.fn(async () => {
        controller.abort(reason);
        return { jobId: "job-1" };
      });
      const poll = vi.fn(async (): Promise<AssetJobPoll> => ({ state: "pending" }));
      const api = apiWith({ estimate: () => ({ usd: 0 }), submit, poll });

      await expect(api.register(request, { signal: controller.signal })).rejects.toBe(reason);
      expect(poll).toHaveBeenCalledTimes(1);
    });

    it("honors the provider override", async () => {
      const registry = createRegistry();
      const ark = createJobHandler([done]);
      const other = createJobHandler([
        { ...done, body: encodeAssetRecord({ ...record, provider: "other" }) }
      ]);
      registry.register("asset", "ark", ark.handler);
      registry.register("asset", "other", other.handler);
      const api = createAssetApi(createTestCtx(registry));

      await expect(api.register(request, { provider: "other" })).resolves.toMatchObject({
        provider: "other"
      });
      expect(ark.submit).not.toHaveBeenCalled();
    });
  });

  describe("estimate", () => {
    it("delegates to the handler without registering", () => {
      const { handler, estimate, submit } = createJobHandler([]);
      estimate.mockReturnValue({ usd: 0.02 });
      const api = apiWith(handler);

      expect(api.estimate(request)).toEqual({ usd: 0.02 });
      expect(estimate).toHaveBeenCalledWith(request);
      expect(submit).not.toHaveBeenCalled();
    });
  });

  describe("providers", () => {
    it('lists registry.providers("asset") in registration order', () => {
      const registry = createRegistry();
      registry.register("asset", "ark", createJobHandler([]).handler);
      registry.register("asset", "apimodels", createJobHandler([]).handler);
      registry.register("video", "fal", {});
      const api = createAssetApi(createTestCtx(registry));

      expect(api.providers()).toEqual(["ark", "apimodels"]);
    });

    it("returns an empty array when nothing is registered", () => {
      expect(createAssetApi(createTestCtx(createRegistry())).providers()).toEqual([]);
    });
  });

  describe("unknown provider", () => {
    it("lists the registered providers", async () => {
      const api = apiWith(createJobHandler([]).handler, "ark");

      await expect(api.register(request, { provider: "acme" })).rejects.toThrow(
        '[ai] No asset provider named "acme" is registered.\n  Available: ark.'
      );
    });

    it('uses "none" when no providers are registered', () => {
      const api = createAssetApi(createTestCtx(createRegistry()));

      expect(() => api.estimate(request)).toThrow(
        '[ai] No asset provider named "ark" is registered.\n  Available: none.'
      );
    });

    it("treats a registration that fails the guard as unknown", async () => {
      const api = apiWith({ estimate: () => ({ usd: 0 }) }, "broken");

      await expect(api.register(request, { provider: "broken" })).rejects.toThrow(
        '[ai] No asset provider named "broken" is registered.\n  Available: broken.'
      );
    });
  });

  describe("types: AssetApi", () => {
    it("register accepts AssetRequest and resolves AssetRecord", () => {
      expectTypeOf<AssetApi["register"]>().parameter(0).toEqualTypeOf<AssetRequest>();
      expectTypeOf<AssetApi["register"]>().returns.resolves.toEqualTypeOf<AssetRecord>();
    });

    it("estimate accepts AssetRequest and returns { usd: number }", () => {
      expectTypeOf<AssetApi["estimate"]>().parameter(0).toEqualTypeOf<AssetRequest>();
      expectTypeOf<AssetApi["estimate"]>().returns.toEqualTypeOf<{ usd: number }>();
    });

    it("providers returns string[]", () => {
      expectTypeOf<AssetApi["providers"]>().returns.toEqualTypeOf<string[]>();
    });

    it("rejects a request without an image", () => {
      // @ts-expect-error -- missing required "image" field
      const bad: AssetRequest = { url: "https://cdn.example/mira.png" };
      expect(bad).toBeDefined();
    });
  });
});
