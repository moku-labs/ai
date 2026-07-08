import { createCoreConfig } from "@moku-labs/core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { limitsPlugin } from "../../index";
import type { Config, LaneSnapshot, LimitsApi } from "../../types";

/**
 * Builds an isolated app registering only `limitsPlugin` (as a core plugin)
 * plus a regular "probe" plugin whose api forwards to `ctx.limits` — proving
 * the injection onto every regular plugin's context, independent of the rest
 * of the framework.
 */
function createTestApp(limitsConfig?: Partial<Config>) {
  const coreConfig = createCoreConfig("limits-test", {
    config: {},
    plugins: [limitsPlugin],
    ...(limitsConfig ? { pluginConfigs: { limits: limitsConfig } } : {})
  });

  const probePlugin = coreConfig.createPlugin("probe", {
    api: ctx => ({
      acquire: (lane: string, opts?: { signal?: AbortSignal }) => ctx.limits.acquire(lane, opts),
      reportOutcome: (lane: string, outcome: "ok" | "retryable-error") =>
        ctx.limits.reportOutcome(lane, outcome),
      snapshot: (lane: string): LaneSnapshot => ctx.limits.snapshot(lane),
      laneConfig: (lane: string) => ctx.limits.laneConfig(lane),
      lanes: (): string[] => ctx.limits.lanes()
    })
  });

  const framework = coreConfig.createCore(coreConfig, { plugins: [probePlugin] });
  return framework.createApp();
}

describe("limits integration", () => {
  it("injects ctx.limits onto a regular plugin's context", () => {
    const app = createTestApp();
    expectTypeOf(app.probe.acquire).toBeFunction();
    expect(typeof app.probe.snapshot).toBe("function");
  });

  it("exposes the limits API directly on the app (core plugin injection)", () => {
    const app = createTestApp();
    expectTypeOf(app.limits).toMatchTypeOf<LimitsApi>();
    expect(app.limits.lanes()).toEqual([]);
  });

  it("allows up to `concurrency` acquires in flight and queues the rest", async () => {
    const app = createTestApp({
      lanes: { "task/provider": { concurrency: 2, rpm: 1_000_000 } }
    });

    const handles = await Promise.all([
      app.probe.acquire("task/provider/default"),
      app.probe.acquire("task/provider/default")
    ]);

    let thirdResolved = false;
    const third = app.probe.acquire("task/provider/default").then(handle => {
      thirdResolved = true;
      return handle;
    });

    await Promise.resolve();
    expect(app.probe.snapshot("task/provider/default").inFlight).toBe(2);
    expect(app.probe.snapshot("task/provider/default").waiting).toBe(1);
    expect(thirdResolved).toBe(false);

    for (const handle of handles) handle.release();
    const thirdHandle = await third;
    expect(thirdResolved).toBe(true);
    thirdHandle.release();
  });

  it("delays the next acquire until the rpm bucket refills", async () => {
    vi.useFakeTimers();
    try {
      const app = createTestApp({
        lanes: { "task/provider": { rpm: 1, concurrency: 10 } }
      });

      const first = await app.probe.acquire("task/provider/default");
      first.release();

      let resolved = false;
      const pending = app.probe.acquire("task/provider/default").then(handle => {
        resolved = true;
        return handle;
      });

      await vi.advanceTimersByTimeAsync(59_000);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1000);
      const handle = await pending;
      expect(resolved).toBe(true);
      handle.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the breaker after the configured consecutive failures and closes on ok", async () => {
    const app = createTestApp({
      lanes: { "task/provider": { breakerThreshold: 2 } }
    });

    app.probe.reportOutcome("task/provider/default", "retryable-error");
    app.probe.reportOutcome("task/provider/default", "retryable-error");
    expect(app.probe.snapshot("task/provider/default").breaker).toBe("open");

    await expect(app.probe.acquire("task/provider/default")).rejects.toMatchObject({
      reason: "breaker-open"
    });

    app.probe.reportOutcome("task/provider/default", "ok");
    expect(app.probe.snapshot("task/provider/default").breaker).toBe("closed");

    const handle = await app.probe.acquire("task/provider/default");
    handle.release();
  });
});
