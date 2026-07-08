import { describe, expect, it, vi } from "vitest";
import { createLimitsApi } from "../../api";
import {
  breakerPhase,
  createLimitsState,
  getOrCreateLane,
  peekLane,
  recordOutcome,
  refillTokens,
  refundToken,
  reserveToken
} from "../../state";
import type { Config, LaneConfig } from "../../types";

const laneConfig: LaneConfig = {
  rpm: 60,
  concurrency: 4,
  breakerThreshold: 5,
  breakerCooldownMs: 30_000
};

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    defaults: laneConfig,
    lanes: {},
    ...overrides
  };
}

describe("createLimitsState", () => {
  it("starts with no lanes tracked", () => {
    const state = createLimitsState();
    expect(state.lanes.size).toBe(0);
  });
});

describe("getOrCreateLane", () => {
  it("creates a full bucket on first touch", () => {
    const state = createLimitsState();
    const lane = getOrCreateLane(state, "voiceover/elevenlabs/default", laneConfig, 1000);
    expect(lane).toEqual({
      tokens: 60,
      lastRefillAt: 1000,
      inFlight: 0,
      waiters: [],
      consecutiveFailures: 0,
      openUntil: 0,
      probing: false
    });
  });

  it("returns the same lane state object on subsequent calls", () => {
    const state = createLimitsState();
    const first = getOrCreateLane(state, "voiceover/elevenlabs/default", laneConfig, 1000);
    first.tokens = 10;
    const second = getOrCreateLane(state, "voiceover/elevenlabs/default", laneConfig, 2000);
    expect(second).toBe(first);
    expect(second.tokens).toBe(10);
  });
});

describe("peekLane", () => {
  it("returns undefined for a lane never touched", () => {
    const state = createLimitsState();
    expect(peekLane(state, "voiceover/elevenlabs/default")).toBeUndefined();
  });

  it("returns the tracked lane once created", () => {
    const state = createLimitsState();
    const created = getOrCreateLane(state, "voiceover/elevenlabs/default", laneConfig, 0);
    expect(peekLane(state, "voiceover/elevenlabs/default")).toBe(created);
  });
});

describe("refillTokens", () => {
  it("adds tokens proportional to elapsed time at the configured rpm", () => {
    const state = createLimitsState();
    const lane = getOrCreateLane(state, "lane", { ...laneConfig, rpm: 60 }, 0);
    lane.tokens = 0;
    // 60 rpm = 1 token/sec; 30s elapsed => +30 tokens
    refillTokens(lane, { ...laneConfig, rpm: 60 }, 30_000);
    expect(lane.tokens).toBe(30);
    expect(lane.lastRefillAt).toBe(30_000);
  });

  it("caps tokens at the bucket capacity (rpm)", () => {
    const state = createLimitsState();
    const lane = getOrCreateLane(state, "lane", laneConfig, 0);
    refillTokens(lane, laneConfig, 1_000_000);
    expect(lane.tokens).toBe(laneConfig.rpm);
  });

  it("is a no-op when now has not advanced", () => {
    const state = createLimitsState();
    const lane = getOrCreateLane(state, "lane", laneConfig, 1000);
    lane.tokens = 5;
    refillTokens(lane, laneConfig, 500);
    expect(lane.tokens).toBe(5);
    expect(lane.lastRefillAt).toBe(1000);
  });
});

describe("reserveToken", () => {
  it("returns 0 wait when a token is immediately available", () => {
    const state = createLimitsState();
    const lane = getOrCreateLane(state, "lane", laneConfig, 0);
    const wait = reserveToken(lane, laneConfig, 0);
    expect(wait).toBe(0);
    expect(lane.tokens).toBe(laneConfig.rpm - 1);
  });

  it("returns a positive wait and lets tokens go negative when the bucket is empty", () => {
    const state = createLimitsState();
    const cfg: LaneConfig = { ...laneConfig, rpm: 1 };
    const lane = getOrCreateLane(state, "lane", cfg, 0);
    // exhaust the single token
    reserveToken(lane, cfg, 0);
    expect(lane.tokens).toBe(0);

    const wait = reserveToken(lane, cfg, 0);
    // 1 rpm => 60_000ms per token; tokens went to -1 => wait 60_000ms
    expect(wait).toBe(60_000);
    expect(lane.tokens).toBe(-1);
  });
});

describe("refundToken", () => {
  it("adds a token back after a reservation is abandoned", () => {
    const state = createLimitsState();
    const lane = getOrCreateLane(state, "lane", laneConfig, 0);
    reserveToken(lane, laneConfig, 0);
    const tokensAfterReserve = lane.tokens;
    refundToken(lane);
    expect(lane.tokens).toBe(tokensAfterReserve + 1);
  });
});

describe("breakerPhase", () => {
  it("is closed when openUntil is 0", () => {
    const state = createLimitsState();
    const lane = getOrCreateLane(state, "lane", laneConfig, 0);
    expect(breakerPhase(lane, 0)).toBe("closed");
  });

  it("is open while now is before openUntil", () => {
    const state = createLimitsState();
    const lane = getOrCreateLane(state, "lane", laneConfig, 0);
    lane.openUntil = 10_000;
    expect(breakerPhase(lane, 5000)).toBe("open");
  });

  it("is half-open once now reaches openUntil", () => {
    const state = createLimitsState();
    const lane = getOrCreateLane(state, "lane", laneConfig, 0);
    lane.openUntil = 10_000;
    expect(breakerPhase(lane, 10_000)).toBe("half-open");
    expect(breakerPhase(lane, 20_000)).toBe("half-open");
  });
});

describe("recordOutcome", () => {
  it("does not open the breaker before the threshold is reached", () => {
    const state = createLimitsState();
    const cfg: LaneConfig = { ...laneConfig, breakerThreshold: 3 };
    const lane = getOrCreateLane(state, "lane", cfg, 0);
    recordOutcome(lane, cfg, "retryable-error", 0);
    recordOutcome(lane, cfg, "retryable-error", 0);
    expect(lane.consecutiveFailures).toBe(2);
    expect(lane.openUntil).toBe(0);
  });

  it("opens the breaker once consecutive failures reach the threshold", () => {
    const state = createLimitsState();
    const cfg: LaneConfig = { ...laneConfig, breakerThreshold: 3, breakerCooldownMs: 5000 };
    const lane = getOrCreateLane(state, "lane", cfg, 0);
    recordOutcome(lane, cfg, "retryable-error", 0);
    recordOutcome(lane, cfg, "retryable-error", 0);
    recordOutcome(lane, cfg, "retryable-error", 1000);
    expect(lane.consecutiveFailures).toBe(3);
    expect(lane.openUntil).toBe(6000);
  });

  it("closes and resets the breaker on an ok outcome", () => {
    const state = createLimitsState();
    const cfg: LaneConfig = { ...laneConfig, breakerThreshold: 2 };
    const lane = getOrCreateLane(state, "lane", cfg, 0);
    recordOutcome(lane, cfg, "retryable-error", 0);
    recordOutcome(lane, cfg, "retryable-error", 0);
    expect(lane.openUntil).not.toBe(0);
    recordOutcome(lane, cfg, "ok", 0);
    expect(lane.consecutiveFailures).toBe(0);
    expect(lane.openUntil).toBe(0);
  });
});

describe("createLimitsApi", () => {
  describe("laneConfig", () => {
    it("returns defaults when no override exists", () => {
      const state = createLimitsState();
      const api = createLimitsApi({ config: makeConfig(), state });
      expect(api.laneConfig("voiceover/elevenlabs/default")).toEqual(laneConfig);
    });

    it("prefers an exact lane override over a prefix override, over defaults", () => {
      const state = createLimitsState();
      const config = makeConfig({
        lanes: {
          "voiceover/elevenlabs": { rpm: 30 },
          "voiceover/elevenlabs/default": { rpm: 10, concurrency: 1 }
        }
      });
      const api = createLimitsApi({ config, state });
      expect(api.laneConfig("voiceover/elevenlabs/default")).toEqual({
        ...laneConfig,
        rpm: 10,
        concurrency: 1
      });
    });

    it("applies a prefix override when no exact override exists", () => {
      const state = createLimitsState();
      const config = makeConfig({ lanes: { "voiceover/elevenlabs": { rpm: 30 } } });
      const api = createLimitsApi({ config, state });
      expect(api.laneConfig("voiceover/elevenlabs/default")).toEqual({ ...laneConfig, rpm: 30 });
    });
  });

  describe("lanes", () => {
    it("lists no lanes before any are touched", () => {
      const state = createLimitsState();
      const api = createLimitsApi({ config: makeConfig(), state });
      expect(api.lanes()).toEqual([]);
    });

    it("lists a lane after it is acquired", async () => {
      const state = createLimitsState();
      const api = createLimitsApi({ config: makeConfig(), state });
      const { release } = await api.acquire("voiceover/elevenlabs/default");
      release();
      expect(api.lanes()).toEqual(["voiceover/elevenlabs/default"]);
    });
  });

  describe("snapshot", () => {
    it("returns a full-bucket, closed-breaker snapshot for an untouched lane", () => {
      const state = createLimitsState();
      const api = createLimitsApi({ config: makeConfig(), state });
      expect(api.snapshot("voiceover/elevenlabs/default")).toEqual({
        lane: "voiceover/elevenlabs/default",
        tokens: laneConfig.rpm,
        inFlight: 0,
        waiting: 0,
        breaker: "closed"
      });
      // must not register the lane as a side effect
      expect(api.lanes()).toEqual([]);
    });

    it("reflects in-flight count while a request holds a slot", async () => {
      const state = createLimitsState();
      const api = createLimitsApi({ config: makeConfig(), state });
      await api.acquire("lane");
      expect(api.snapshot("lane").inFlight).toBe(1);
    });
  });

  describe("acquire", () => {
    it("grants capacity immediately when tokens and concurrency are available", async () => {
      const state = createLimitsState();
      const api = createLimitsApi({ config: makeConfig(), state });
      const { release } = await api.acquire("lane");
      expect(typeof release).toBe("function");
      expect(api.snapshot("lane").inFlight).toBe(1);
      release();
      expect(api.snapshot("lane").inFlight).toBe(0);
    });

    it("rejects immediately with reason breaker-open when the breaker is open", async () => {
      const state = createLimitsState();
      const config = makeConfig({ lanes: { lane: { breakerThreshold: 1 } } });
      const api = createLimitsApi({ config, state });
      api.reportOutcome("lane", "retryable-error");
      expect(api.snapshot("lane").breaker).toBe("open");

      await expect(api.acquire("lane")).rejects.toMatchObject({ reason: "breaker-open" });
      // rejection must not consume a token or leave inFlight incremented
      expect(api.snapshot("lane").inFlight).toBe(0);
    });

    it("serves concurrency waiters in FIFO order as slots free up", async () => {
      const state = createLimitsState();
      const config = makeConfig({ lanes: { lane: { concurrency: 1, rpm: 1_000_000 } } });
      const api = createLimitsApi({ config, state });

      const first = await api.acquire("lane");
      const order: number[] = [];
      const second = api.acquire("lane").then(handle => {
        order.push(2);
        return handle;
      });
      const third = api.acquire("lane").then(handle => {
        order.push(3);
        return handle;
      });

      // give the microtask queue a tick to enqueue both waiters
      await Promise.resolve();
      expect(api.snapshot("lane").waiting).toBe(2);

      first.release();
      const secondHandle = await second;
      expect(order).toEqual([2]);

      secondHandle.release();
      await third;
      expect(order).toEqual([2, 3]);
    });

    it("does not free a second slot when release is called twice", async () => {
      const state = createLimitsState();
      const config = makeConfig({ lanes: { lane: { concurrency: 1, rpm: 1_000_000 } } });
      const api = createLimitsApi({ config, state });

      const { release } = await api.acquire("lane");
      release();
      release();
      expect(api.snapshot("lane").inFlight).toBe(0);

      const second = await api.acquire("lane");
      expect(api.snapshot("lane").inFlight).toBe(1);
      second.release();
    });

    it("delays the acquire until the rpm bucket refills, using fake timers", async () => {
      vi.useFakeTimers();
      try {
        const state = createLimitsState();
        const config = makeConfig({ lanes: { lane: { rpm: 1, concurrency: 10 } } });
        const api = createLimitsApi({ config, state });

        const { release: firstRelease } = await api.acquire("lane");
        firstRelease();

        let resolved = false;
        const pending = api.acquire("lane").then(handle => {
          resolved = true;
          return handle;
        });

        await vi.advanceTimersByTimeAsync(30_000);
        expect(resolved).toBe(false);

        await vi.advanceTimersByTimeAsync(30_000);
        const { release } = await pending;
        expect(resolved).toBe(true);
        release();
      } finally {
        vi.useRealTimers();
      }
    });

    it("removes a queued concurrency waiter on abort, leaking no slot", async () => {
      const state = createLimitsState();
      const config = makeConfig({ lanes: { lane: { concurrency: 1, rpm: 1_000_000 } } });
      const api = createLimitsApi({ config, state });

      const { release } = await api.acquire("lane");
      const controller = new AbortController();
      const waiting = api.acquire("lane", { signal: controller.signal });
      await Promise.resolve();
      expect(api.snapshot("lane").waiting).toBe(1);

      controller.abort();
      await expect(waiting).rejects.toBeDefined();
      expect(api.snapshot("lane").waiting).toBe(0);

      release();
      const next = await api.acquire("lane");
      expect(api.snapshot("lane").inFlight).toBe(1);
      next.release();
    });

    it("removes a token-wait on abort without leaking a reservation", async () => {
      vi.useFakeTimers();
      try {
        const state = createLimitsState();
        const config = makeConfig({ lanes: { lane: { rpm: 1, concurrency: 10 } } });
        const api = createLimitsApi({ config, state });

        const { release } = await api.acquire("lane");
        release();

        const controller = new AbortController();
        const waiting = api.acquire("lane", { signal: controller.signal });
        controller.abort();
        await expect(waiting).rejects.toBeDefined();

        // the abandoned reservation must be refunded: tokens return to 0 (not left at -1)
        expect(api.snapshot("lane").tokens).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("half-open probe", () => {
    it("admits exactly one trial probe during half-open and rejects concurrent callers", async () => {
      vi.useFakeTimers();
      try {
        const state = createLimitsState();
        const config = makeConfig({
          lanes: { lane: { breakerThreshold: 1, breakerCooldownMs: 30_000 } }
        });
        const api = createLimitsApi({ config, state });

        // Trip the breaker, then let the cooldown elapse → half-open.
        api.reportOutcome("lane", "retryable-error");
        await expect(api.acquire("lane")).rejects.toMatchObject({ reason: "breaker-open" });
        vi.advanceTimersByTime(30_000);
        expect(api.snapshot("lane").breaker).toBe("half-open");

        // First caller is the single probe; concurrent callers are rejected.
        const probe = await api.acquire("lane");
        await expect(api.acquire("lane")).rejects.toMatchObject({ reason: "breaker-open" });

        // A successful probe outcome closes the breaker and re-admits everyone.
        api.reportOutcome("lane", "ok");
        expect(api.snapshot("lane").breaker).toBe("closed");
        const next = await api.acquire("lane");
        probe.release();
        next.release();
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-opens the breaker when the probe fails and allows a fresh probe after cooldown", async () => {
      vi.useFakeTimers();
      try {
        const state = createLimitsState();
        const config = makeConfig({
          lanes: { lane: { breakerThreshold: 1, breakerCooldownMs: 30_000 } }
        });
        const api = createLimitsApi({ config, state });

        api.reportOutcome("lane", "retryable-error");
        vi.advanceTimersByTime(30_000);
        const probe = await api.acquire("lane");
        probe.release();

        // Failed probe → breaker re-opens for another cooldown.
        api.reportOutcome("lane", "retryable-error");
        expect(api.snapshot("lane").breaker).toBe("open");
        await expect(api.acquire("lane")).rejects.toMatchObject({ reason: "breaker-open" });

        // After the next cooldown a fresh probe is admitted (probing flag cleared).
        vi.advanceTimersByTime(30_000);
        const secondProbe = await api.acquire("lane");
        secondProbe.release();
      } finally {
        vi.useRealTimers();
      }
    });

    it("releases the probe claim when the probing acquire aborts mid-wait", async () => {
      const state = createLimitsState();
      const config = makeConfig({
        lanes: {
          lane: { concurrency: 1, rpm: 1_000_000, breakerThreshold: 1, breakerCooldownMs: 0 }
        }
      });
      const api = createLimitsApi({ config, state });

      // Occupy the only concurrency slot, then trip the breaker; cooldown 0
      // makes the lane immediately half-open.
      const holder = await api.acquire("lane");
      api.reportOutcome("lane", "retryable-error");
      expect(api.snapshot("lane").breaker).toBe("half-open");

      // The probe claims its slot but parks in the concurrency queue…
      const controller = new AbortController();
      const probePromise = api.acquire("lane", { signal: controller.signal });
      await expect(api.acquire("lane")).rejects.toMatchObject({ reason: "breaker-open" });

      // …and an abort must hand the probe claim back.
      controller.abort();
      await expect(probePromise).rejects.toThrow();
      const nextProbePromise = api.acquire("lane");
      holder.release();
      const nextProbe = await nextProbePromise;
      nextProbe.release();
    });
  });

  describe("reportOutcome", () => {
    it("increments consecutive failures on retryable-error", () => {
      const state = createLimitsState();
      const api = createLimitsApi({ config: makeConfig(), state });
      api.reportOutcome("lane", "retryable-error");
      expect(api.snapshot("lane").breaker).toBe("closed");
    });

    it("resets failures and closes the breaker on ok", () => {
      const state = createLimitsState();
      const config = makeConfig({ lanes: { lane: { breakerThreshold: 1 } } });
      const api = createLimitsApi({ config, state });
      api.reportOutcome("lane", "retryable-error");
      expect(api.snapshot("lane").breaker).toBe("open");
      api.reportOutcome("lane", "ok");
      expect(api.snapshot("lane").breaker).toBe("closed");
    });
  });
});
