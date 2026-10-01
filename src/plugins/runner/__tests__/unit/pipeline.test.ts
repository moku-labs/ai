import { describe, expect, it, vi } from "vitest";
import type { DoneArtifact, GateResult } from "../../../journal/types";
import type { LaneSnapshot, LimitsApi } from "../../../limits/types";
import {
  artifactKeyOf,
  createDrainController,
  executeItem,
  isExecutableHandler,
  resolveHandler
} from "../../pipeline";
import { openClaim } from "../../state";
import type {
  ClaimVerdict,
  ExecutableHandler,
  JobPoll,
  ProviderErrorHint,
  RunnerContext,
  UnstampedRunEvent
} from "../../types";
import {
  type CallLog,
  createFakeRunnerContext,
  fakeHandler,
  fakeItemRow,
  fakePlan
} from "./fixtures";

/**
 * Collects every `RunEvent` reported during a test into an array, usable
 * directly as the `report` callback `executeItem` expects.
 *
 * @returns A `report`-shaped function plus the array it appends to.
 * @example
 * ```ts
 * const { report, events } = collectReports();
 * await executeItem(ctx, item, fakePlan(3), drain, report, Promise.resolve());
 * ```
 */
function collectReports(): {
  report: (event: UnstampedRunEvent) => void;
  events: UnstampedRunEvent[];
} {
  const events: UnstampedRunEvent[] = [];
  return {
    report: (event: UnstampedRunEvent): void => {
      events.push(event);
    },
    events
  };
}

/**
 * Lets pending promise callbacks and timers run, so an item reaches its next wait.
 *
 * @returns Resolves on the next macrotask.
 * @example
 * ```ts
 * await flush();
 * ```
 */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Builds a fake lane with one concurrency slot: `acquire` waits until the
 * slot is free, `release` hands it to the next waiter.
 *
 * @returns The fake `acquire`, plus a probe telling whether the slot is held.
 * @example
 * ```ts
 * const slot = oneSlotLane();
 * const ctx = createFakeRunnerContext(log, { limits: { acquire: slot.acquire } });
 * ```
 */
function oneSlotLane(): {
  acquire: () => Promise<{ release: () => void }>;
  busy: () => boolean;
} {
  let held = false;
  const waiters: Array<() => void> = [];

  const release = (): void => {
    held = false;
    waiters.shift()?.();
  };
  const acquire = async (): Promise<{ release: () => void }> => {
    while (held) await new Promise<void>(resolve => waiters.push(resolve));
    held = true;
    return { release };
  };

  return { acquire, busy: () => held };
}

/**
 * Builds a fake `limits.acquire` that rejects the way an open breaker does
 * (`reason: "breaker-open"`) for its first `refusals` calls, then grants a
 * slot. Every call and release goes to the call log.
 *
 * @param log - Shared call-order log.
 * @param refusals - How many leading calls reject with an open breaker.
 * @returns The fake `acquire`.
 * @example
 * ```ts
 * const acquire = openBreakerLane(log, 1); // first call rejects, the second one gets a slot
 * ```
 */
function openBreakerLane(log: CallLog, refusals: number): () => Promise<{ release: () => void }> {
  let calls = 0;
  return async (): Promise<{ release: () => void }> => {
    calls += 1;
    log.push("limits.acquire");
    if (calls <= refusals) {
      throw Object.assign(new Error("[ai] limits: breaker open."), { reason: "breaker-open" });
    }
    return {
      release: (): void => {
        log.push("limits.release");
      }
    };
  };
}

/**
 * Builds fake `limits.laneConfig` and `limits.snapshot` for a lane whose
 * breaker is in `phase`, with a `cooldownMs` breaker cooldown.
 *
 * @param phase - The breaker phase `snapshot` reports.
 * @param cooldownMs - The lane's `breakerCooldownMs`.
 * @returns The two fakes, to spread into the `limits` override.
 * @example
 * ```ts
 * breakerLane("half-open", 0).snapshot("fakeTask/fakeProvider/default").breaker; // "half-open"
 * ```
 */
function breakerLane(
  phase: LaneSnapshot["breaker"],
  cooldownMs: number
): Pick<LimitsApi, "laneConfig" | "snapshot"> {
  return {
    laneConfig: vi.fn(() => ({
      rpm: 60,
      concurrency: 4,
      breakerThreshold: 5,
      breakerCooldownMs: cooldownMs
    })),
    snapshot: vi.fn((lane: string) => ({
      lane,
      tokens: 60,
      inFlight: 0,
      waiting: 0,
      breaker: phase
    }))
  };
}

// ---------------------------------------------------------------------------
// isExecutableHandler — the runner's single audited dynamic boundary
// ---------------------------------------------------------------------------

describe("isExecutableHandler", () => {
  it("accepts an object exposing callable estimate/execute", () => {
    expect(isExecutableHandler(fakeHandler([]))).toBe(true);
  });

  it("rejects null", () => {
    // eslint-disable-next-line unicorn/no-null -- exercising the guard's null branch
    expect(isExecutableHandler(null)).toBe(false);
  });

  it("rejects a non-object", () => {
    expect(isExecutableHandler("not a handler")).toBe(false);
  });

  it("rejects an object missing execute", () => {
    expect(isExecutableHandler({ estimate: () => ({ usd: 0 }) })).toBe(false);
  });

  it("rejects an object missing estimate", () => {
    expect(isExecutableHandler({ execute: async () => ({}) })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveHandler
// ---------------------------------------------------------------------------

describe("resolveHandler", () => {
  it("returns the narrowed handler when the registry resolves one", () => {
    const log: CallLog = [];
    const handler = fakeHandler(log);
    const ctx = createFakeRunnerContext(log, { registry: { resolve: (): unknown => handler } });

    expect(resolveHandler(ctx, "fakeTask", "fakeProvider")).toBe(handler);
  });

  it("throws a two-line error when nothing is registered", () => {
    const log: CallLog = [];

    const ctx = createFakeRunnerContext(log, { registry: { resolve: (): unknown => undefined } });

    expect(() => resolveHandler(ctx, "fakeTask", "fakeProvider")).toThrow(
      /^\[ai\] No executable handler registered/
    );
  });

  it("throws when the resolved value doesn't satisfy the ExecutableHandler protocol", () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log, { registry: { resolve: (): unknown => ({}) } });

    expect(() => resolveHandler(ctx, "fakeTask", "fakeProvider")).toThrow(
      /^\[ai\] No executable handler registered/
    );
  });
});

// ---------------------------------------------------------------------------
// artifactKeyOf
// ---------------------------------------------------------------------------

describe("artifactKeyOf", () => {
  // eslint-disable-next-line unicorn/no-null -- ItemRow.packVersion is typed `string | null`; the single source of the null literal for this file
  const NO_PACK_VERSION = null;

  it("is deterministic for the same inputs", () => {
    expect(artifactKeyOf("pk-1", "elevenlabs", "1.0.0")).toBe(
      artifactKeyOf("pk-1", "elevenlabs", "1.0.0")
    );
  });

  it("differs when the provider differs", () => {
    expect(artifactKeyOf("pk-1", "elevenlabs", NO_PACK_VERSION)).not.toBe(
      artifactKeyOf("pk-1", "openai", NO_PACK_VERSION)
    );
  });

  it("differs when the pack version differs", () => {
    expect(artifactKeyOf("pk-1", "elevenlabs", "1.0.0")).not.toBe(
      artifactKeyOf("pk-1", "elevenlabs", "2.0.0")
    );
  });
});

// ---------------------------------------------------------------------------
// executeItem — step ordering, gate outcomes, retry taxonomy, abort drain
// ---------------------------------------------------------------------------

describe("executeItem", () => {
  it("runs the happy path in exact order: acquire → gate → recordAttempt → execute → finishAttempt → reportOutcome(ok) → put → commitDone → release", async () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    const item = fakeItemRow();
    const drain = createDrainController(undefined);
    const { report, events } = collectReports();

    await executeItem(ctx, item, fakePlan(3), drain, report, Promise.resolve());

    expect(log).toEqual([
      "limits.acquire",
      `journal.gateToDispatching(${item.id})`,
      `journal.recordAttempt(${item.id})`,
      "handler.execute",
      "journal.finishAttempt(done)",
      "limits.reportOutcome(ok)",
      "store.put",
      `journal.commitDone(${item.id})`,
      "limits.release"
    ]);
    expect(events.map(event => event.type)).toEqual([
      "item:queued",
      "item:dispatching",
      "item:done"
    ]);
  });

  it("releases the lane slot and never dispatches on a duplicate gate result", async () => {
    const log: CallLog = [];
    const gateToDispatching = (itemId: string): GateResult => {
      log.push(`journal.gateToDispatching(${itemId})`);
      return { ok: false, reason: "duplicate" };
    };
    const ctx = createFakeRunnerContext(log, { journal: { gateToDispatching } });
    const item = fakeItemRow();
    const drain = createDrainController(undefined);
    const { report, events } = collectReports();

    await executeItem(ctx, item, fakePlan(3), drain, report, Promise.resolve());

    expect(log).toEqual([
      "limits.acquire",
      `journal.gateToDispatching(${item.id})`,
      "limits.release"
    ]);
    expect(events.map(event => event.type)).toEqual(["item:queued"]);
    expect(drain.budgetStopped).toBe(false);
  });

  it("triggers budget-stop and releases the lane slot on a budget gate result", async () => {
    const log: CallLog = [];
    const gateToDispatching = (itemId: string): GateResult => {
      log.push(`journal.gateToDispatching(${itemId})`);
      return { ok: false, reason: "budget" };
    };
    const ctx = createFakeRunnerContext(log, { journal: { gateToDispatching } });
    const item = fakeItemRow();
    const drain = createDrainController(undefined);
    const { report } = collectReports();

    await executeItem(ctx, item, fakePlan(3), drain, report, Promise.resolve());

    expect(drain.budgetStopped).toBe(true);
    expect(drain.signal.aborted).toBe(true);
    expect(log).toContain("limits.release");
  });

  describe("retry taxonomy", () => {
    it("retries a 5xx failure, then succeeds on the next attempt", async () => {
      const log: CallLog = [];
      let executeCalls = 0;
      const handler = fakeHandler(log, {
        execute: async () => {
          executeCalls += 1;
          if (executeCalls === 1) {
            throw Object.assign(new Error("server error"), { status: 500 });
          }
          return { body: new TextEncoder().encode("ok"), mimeType: "text/plain", costUsd: 0.1 };
        }
      });
      const ctx = createFakeRunnerContext(log, {
        config: { retryBaseMs: 1 },
        registry: { resolve: (): unknown => handler }
      });
      const item = fakeItemRow();
      const drain = createDrainController(undefined);
      const { report, events } = collectReports();

      await executeItem(ctx, item, fakePlan(3), drain, report, Promise.resolve());

      expect(events.map(event => event.type)).toEqual([
        "item:queued",
        "item:dispatching",
        "item:retry",
        "item:dispatching",
        "item:done"
      ]);
      expect(log.filter(entry => entry.startsWith("journal.markFailed"))).toEqual([
        `journal.markFailed(${item.id},retry)`
      ]);
      expect(log.filter(entry => entry === "limits.acquire")).toHaveLength(2);
    });

    it("retries a 429 failure and honors a Retry-After larger than the computed backoff", async () => {
      const RETRY_AFTER_MS = 30;
      const log: CallLog = [];
      let executeCalls = 0;
      const handler = fakeHandler(log, {
        execute: async () => {
          executeCalls += 1;
          if (executeCalls === 1) {
            throw Object.assign(new Error("rate limited"), {
              status: 429,
              retryAfterMs: RETRY_AFTER_MS
            });
          }
          return { body: new TextEncoder().encode("ok"), mimeType: "text/plain", costUsd: 0.1 };
        }
      });
      // A tiny retryBaseMs keeps the COMPUTED backoff far below RETRY_AFTER_MS,
      // so the real elapsed wait below only makes sense if Retry-After won.
      const ctx = createFakeRunnerContext(log, {
        config: { retryBaseMs: 1 },
        registry: { resolve: (): unknown => handler }
      });
      const item = fakeItemRow();
      const drain = createDrainController(undefined);
      const { report, events } = collectReports();

      const startedAt = Date.now();
      await executeItem(ctx, item, fakePlan(3), drain, report, Promise.resolve());
      const elapsedMs = Date.now() - startedAt;

      expect(events.at(-1)?.type).toBe("item:done");
      // A Node timer can fire about 1 ms early against Date.now(): 5 ms slack.
      expect(elapsedMs).toBeGreaterThanOrEqual(RETRY_AFTER_MS - 5);
    });

    it("retries a timeout failure", async () => {
      const log: CallLog = [];
      let executeCalls = 0;
      const handler = fakeHandler(log, {
        execute: async () => {
          executeCalls += 1;
          if (executeCalls === 1) {
            throw Object.assign(new Error("timed out"), { kind: "timeout" });
          }
          return { body: new TextEncoder().encode("ok"), mimeType: "text/plain", costUsd: 0.1 };
        }
      });
      const ctx = createFakeRunnerContext(log, {
        config: { retryBaseMs: 1 },
        registry: { resolve: (): unknown => handler }
      });
      const item = fakeItemRow();
      const drain = createDrainController(undefined);
      const { report, events } = collectReports();

      await executeItem(ctx, item, fakePlan(3), drain, report, Promise.resolve());

      expect(events.at(-1)?.type).toBe("item:done");
    });

    it("retries a network failure", async () => {
      const log: CallLog = [];
      let executeCalls = 0;
      const handler = fakeHandler(log, {
        execute: async () => {
          executeCalls += 1;
          if (executeCalls === 1) {
            throw Object.assign(new Error("dns failure"), { kind: "network" });
          }
          return { body: new TextEncoder().encode("ok"), mimeType: "text/plain", costUsd: 0.1 };
        }
      });
      const ctx = createFakeRunnerContext(log, {
        config: { retryBaseMs: 1 },
        registry: { resolve: (): unknown => handler }
      });
      const item = fakeItemRow();
      const drain = createDrainController(undefined);
      const { report, events } = collectReports();

      await executeItem(ctx, item, fakePlan(3), drain, report, Promise.resolve());

      expect(events.at(-1)?.type).toBe("item:done");
    });

    it("treats a non-429 4xx as terminal failed on the first attempt (never retries)", async () => {
      const log: CallLog = [];
      const handler = fakeHandler(log, {
        execute: async () => {
          throw Object.assign(new Error("bad request"), { status: 400 });
        }
      });
      const ctx = createFakeRunnerContext(log, { registry: { resolve: (): unknown => handler } });
      const item = fakeItemRow();
      const drain = createDrainController(undefined);
      const { report, events } = collectReports();

      await executeItem(ctx, item, fakePlan(3), drain, report, Promise.resolve());

      expect(events.map(event => event.type)).toEqual([
        "item:queued",
        "item:dispatching",
        "item:failed"
      ]);
      expect(log).toContain(`journal.markFailed(${item.id},terminal)`);
      expect(log.filter(entry => entry === "limits.acquire")).toHaveLength(1);
    });

    it("treats content-policy as terminal flagged, never re-queued, and never reports a breaker outcome", async () => {
      const log: CallLog = [];
      const handler = fakeHandler(log, {
        execute: async () => {
          throw Object.assign(new Error("flagged content"), { kind: "content-policy" });
        }
      });
      const ctx = createFakeRunnerContext(log, { registry: { resolve: (): unknown => handler } });
      const item = fakeItemRow();
      const drain = createDrainController(undefined);
      const { report, events } = collectReports();

      await executeItem(ctx, item, fakePlan(3), drain, report, Promise.resolve());

      expect(events.map(event => event.type)).toEqual([
        "item:queued",
        "item:dispatching",
        "item:flagged"
      ]);
      expect(log).toContain(`journal.markFlagged(${item.id})`);
      expect(log.some(entry => entry.startsWith("limits.reportOutcome"))).toBe(false);
    });

    it("exhausts maxAttempts and marks the item terminally failed", async () => {
      const log: CallLog = [];
      const handler = fakeHandler(log, {
        execute: async () => {
          throw Object.assign(new Error("server error"), { status: 500 });
        }
      });
      const ctx = createFakeRunnerContext(log, {
        config: { maxAttempts: 2, retryBaseMs: 1 },
        registry: { resolve: (): unknown => handler }
      });
      const item = fakeItemRow();
      const drain = createDrainController(undefined);
      const { report, events } = collectReports();

      await executeItem(ctx, item, fakePlan(2), drain, report, Promise.resolve());

      expect(events.map(event => event.type)).toEqual([
        "item:queued",
        "item:dispatching",
        "item:retry",
        "item:dispatching",
        "item:failed"
      ]);
      expect(log.filter(entry => entry === "limits.acquire")).toHaveLength(2);
      expect(log).toContain(`journal.markFailed(${item.id},terminal)`);
    });
  });

  describe("lane slot during retry backoff", () => {
    it("releases the lane slot before sleeping the backoff, so another item on the lane runs meanwhile", async () => {
      const log: CallLog = [];
      const slot = oneSlotLane();
      let executeCalls = 0;
      const handler = fakeHandler(log, {
        execute: async () => {
          executeCalls += 1;
          if (executeCalls === 1) {
            throw Object.assign(new Error("rate limited"), { status: 429, retryAfterMs: 60_000 });
          }
          return { body: new TextEncoder().encode("ok"), mimeType: "text/plain", costUsd: 0.1 };
        }
      });
      const ctx = createFakeRunnerContext(log, {
        config: { retryBaseMs: 1 },
        registry: { resolve: (): unknown => handler },
        limits: { acquire: slot.acquire }
      });
      const controller = new AbortController();
      const drain = createDrainController(controller.signal);
      const first = collectReports();
      const second = collectReports();

      const firstRun = executeItem(
        ctx,
        fakeItemRow({ id: "item-a" }),
        fakePlan(3),
        drain,
        first.report,
        Promise.resolve()
      );
      await flush();
      expect(first.events.at(-1)?.type).toBe("item:retry");

      const secondRun = executeItem(
        ctx,
        fakeItemRow({ id: "item-b" }),
        fakePlan(3),
        drain,
        second.report,
        Promise.resolve()
      );
      await Promise.race([secondRun, flush().then(flush)]);

      expect(second.events.at(-1)?.type).toBe("item:done");

      controller.abort();
      await Promise.all([firstRun, secondRun]);
      expect(slot.busy()).toBe(false);
    });

    it("removes the abort listener of every backoff wait from the drain signal", async () => {
      const log: CallLog = [];
      let executeCalls = 0;
      const handler = fakeHandler(log, {
        execute: async () => {
          executeCalls += 1;
          if (executeCalls <= 2) throw Object.assign(new Error("server error"), { status: 500 });
          return { body: new TextEncoder().encode("ok"), mimeType: "text/plain", costUsd: 0.1 };
        }
      });
      const ctx = createFakeRunnerContext(log, {
        config: { retryBaseMs: 4 },
        registry: { resolve: (): unknown => handler }
      });
      const drain = createDrainController(undefined);
      const added = vi.spyOn(drain.signal, "addEventListener");
      const removed = vi.spyOn(drain.signal, "removeEventListener");
      const { report, events } = collectReports();

      await executeItem(ctx, fakeItemRow(), fakePlan(3), drain, report, Promise.resolve());

      // Two retries, two backoff waits: each wait takes its listener off the run-long signal.
      const abortAdds = added.mock.calls.filter(([type]) => type === "abort");
      const abortRemoves = removed.mock.calls.filter(([type]) => type === "abort");
      expect(events.at(-1)?.type).toBe("item:done");
      expect(abortAdds).toHaveLength(2);
      expect(abortRemoves.map(([, listener]) => listener)).toEqual(
        abortAdds.map(([, listener]) => listener)
      );
    });
  });

  describe("open lane breaker", () => {
    const LANE = "fakeTask/fakeProvider/default";
    /** The runner's floor between two asks of a refusing lane (LANE_OPEN_MIN_WAIT_MS). */
    const MIN_WAIT_MS = 250;

    it.each<[LaneSnapshot["breaker"], number, number]>([
      ["open", 1000, 1000],
      ["open", 25, MIN_WAIT_MS],
      ["half-open", 30_000, MIN_WAIT_MS],
      ["half-open", 0, MIN_WAIT_MS],
      ["closed", 30_000, MIN_WAIT_MS]
    ])("an %s lane with a %i ms cooldown logs runner:lane-open and is asked again after %i ms", async (phase, cooldownMs, waitMs) => {
      vi.useFakeTimers();
      try {
        const log: CallLog = [];
        const ctx = createFakeRunnerContext(log, {
          limits: { acquire: openBreakerLane(log, 1), ...breakerLane(phase, cooldownMs) }
        });
        const item = fakeItemRow();
        const { report, events } = collectReports();

        const running = executeItem(
          ctx,
          item,
          fakePlan(3),
          createDrainController(undefined),
          report,
          Promise.resolve()
        );
        await vi.advanceTimersByTimeAsync(waitMs - 1);
        expect(log).toEqual(["limits.acquire"]);

        await vi.advanceTimersByTimeAsync(1);
        expect(log.slice(0, 3)).toEqual([
          "limits.acquire",
          "limits.acquire",
          `journal.gateToDispatching(${item.id})`
        ]);
        expect(events.map(event => event.type)).toEqual([
          "item:queued",
          "item:dispatching",
          "item:done"
        ]);
        await expect(running).resolves.toBe("settled");
        expect(ctx.log.warn).toHaveBeenCalledWith("runner:lane-open", {
          itemId: item.id,
          lane: LANE
        });
        expect(ctx.limits.snapshot).toHaveBeenCalledWith(LANE);
      } finally {
        vi.useRealTimers();
      }
    });

    it("never asks faster than the floor with a zero cooldown: three refusals are three waits, then the item runs", async () => {
      vi.useFakeTimers();
      try {
        const log: CallLog = [];
        const refuseThrice = openBreakerLane(log, 3);
        const askedAt: number[] = [];
        const acquire = (): Promise<{ release: () => void }> => {
          askedAt.push(Date.now());
          return refuseThrice();
        };
        const ctx = createFakeRunnerContext(log, {
          limits: { acquire, ...breakerLane("half-open", 0) }
        });
        const { report, events } = collectReports();
        const startedAt = Date.now();

        const running = executeItem(
          ctx,
          fakeItemRow(),
          fakePlan(3),
          createDrainController(undefined),
          report,
          Promise.resolve()
        );
        await vi.advanceTimersByTimeAsync(3 * MIN_WAIT_MS);

        expect(askedAt.map(at => at - startedAt)).toEqual([
          0,
          MIN_WAIT_MS,
          2 * MIN_WAIT_MS,
          3 * MIN_WAIT_MS
        ]);
        // One wait, one warning: the three refusals do not flood the log.
        expect(ctx.log.warn).toHaveBeenCalledTimes(1);
        expect(events.at(-1)?.type).toBe("item:done");
        await expect(running).resolves.toBe("settled");
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops waiting out the cooldown when the run is paused, and leaves the item queued", async () => {
      vi.useFakeTimers();
      try {
        const log: CallLog = [];
        const ctx = createFakeRunnerContext(log, {
          limits: {
            acquire: openBreakerLane(log, Number.POSITIVE_INFINITY),
            ...breakerLane("open", 30_000)
          }
        });
        const controller = new AbortController();
        const { report, events } = collectReports();
        let settlement: string | undefined;

        const running = executeItem(
          ctx,
          fakeItemRow(),
          fakePlan(3),
          createDrainController(controller.signal),
          report,
          Promise.resolve()
        ).then(value => {
          settlement = value;
        });
        await vi.advanceTimersByTimeAsync(1000);
        expect(settlement).toBeUndefined();

        // No fake time passes: only the abort can end the 30 s wait.
        controller.abort();
        await vi.advanceTimersByTimeAsync(0);

        expect(settlement).toBe("settled");
        expect(log).toEqual(["limits.acquire"]);
        expect(events.map(event => event.type)).toEqual(["item:queued"]);
        await running;
      } finally {
        vi.useRealTimers();
      }
    });

    it("rethrows an acquire rejection that is neither an abort nor an open breaker", async () => {
      const log: CallLog = [];
      const ctx = createFakeRunnerContext(log, {
        limits: {
          acquire: async (): Promise<{ release: () => void }> => {
            throw new Error("[ai] limits: lane state is broken.");
          }
        }
      });

      await expect(
        executeItem(
          ctx,
          fakeItemRow(),
          fakePlan(3),
          createDrainController(undefined),
          collectReports().report,
          Promise.resolve()
        )
      ).rejects.toThrow("[ai] limits: lane state is broken.");
      expect(log).toEqual([]);
    });
  });

  describe("abort drain", () => {
    it("admits no items when the drain signal is already aborted", async () => {
      const log: CallLog = [];
      const ctx = createFakeRunnerContext(log);
      const item = fakeItemRow();
      const controller = new AbortController();
      controller.abort();
      const drain = createDrainController(controller.signal);
      const { report, events } = collectReports();

      await executeItem(ctx, item, fakePlan(3), drain, report, Promise.resolve());

      expect(log).toEqual([]);
      expect(events.map(event => event.type)).toEqual(["item:queued"]);
    });

    it("gives back a lane slot granted after the run stopped, and makes no provider call", async () => {
      const log: CallLog = [];
      const controller = new AbortController();
      const acquire = async (): Promise<{ release: () => void }> => {
        log.push("limits.acquire");
        // The pause lands while the slot is granted: limits hands it over anyway.
        controller.abort();
        return {
          release: (): void => {
            log.push("limits.release");
          }
        };
      };
      const ctx = createFakeRunnerContext(log, { limits: { acquire } });
      const { report, events } = collectReports();

      const settlement = await executeItem(
        ctx,
        fakeItemRow(),
        fakePlan(3),
        createDrainController(controller.signal),
        report,
        Promise.resolve()
      );

      expect(settlement).toBe("settled");
      expect(log).toEqual(["limits.acquire", "limits.release"]);
      expect(events.map(event => event.type)).toEqual(["item:queued"]);
    });

    it("lets an in-flight retry attempt finish, then stops admitting new attempts once aborted", async () => {
      const log: CallLog = [];
      const controller = new AbortController();
      let executeCalls = 0;
      const handler = fakeHandler(log, {
        execute: async () => {
          executeCalls += 1;
          throw Object.assign(new Error("server error"), { status: 500 });
        }
      });
      const ctx = createFakeRunnerContext(log, {
        config: { retryBaseMs: 1000 },
        registry: { resolve: (): unknown => handler }
      });
      const item = fakeItemRow();
      const drain = createDrainController(controller.signal);
      const events: UnstampedRunEvent[] = [];
      // Aborts as soon as the retry is reported — synchronously before the
      // pending `delay()` wait starts, so the wait resolves immediately and
      // the loop exits on its next abort check instead of waiting out the
      // (deliberately huge) retryBaseMs.
      const report = (event: UnstampedRunEvent): void => {
        events.push(event);
        if (event.type === "item:retry") controller.abort();
      };

      await executeItem(ctx, item, fakePlan(3), drain, report, Promise.resolve());

      expect(events.map(event => event.type)).toEqual([
        "item:queued",
        "item:dispatching",
        "item:retry"
      ]);
      // Exactly the one in-flight attempt ran to completion; the abort only
      // stopped the NEXT admission, never a second execute() call.
      expect(executeCalls).toBe(1);
    });
  });
});

/**
 * Runs one leader item and returns the verdict its claim settled with.
 *
 * @param options - Handler error hint, attempt ceiling and gate override.
 * @param options.hint - Error fields the handler throws with; omit for success.
 * @param options.message - The thrown error's message. Default "provider said no".
 * @param options.maxAttempts - Attempt ceiling. Default 3.
 * @param options.gate - Gate result override.
 * @returns The verdict and whether the claim map is empty afterwards.
 * @example
 * ```ts
 * const { verdict } = await leaderVerdict({ hint: { status: 400 } });
 * ```
 */
async function leaderVerdict(
  options: { hint?: object; message?: string; maxAttempts?: number; gate?: GateResult } = {}
): Promise<{ verdict: ClaimVerdict | undefined; claimsLeft: number }> {
  const log: CallLog = [];
  const message = options.message ?? "provider said no";
  const handler = fakeHandler(log, {
    execute: async () => {
      if (options.hint) throw Object.assign(new Error(message), options.hint);
      return { body: new TextEncoder().encode("ok"), mimeType: "text/plain", costUsd: 0.1 };
    }
  });
  const gate = options.gate;
  const ctx = createFakeRunnerContext(log, {
    config: { retryBaseMs: 1 },
    registry: { resolve: (): unknown => handler },
    ...(gate ? { journal: { gateToDispatching: () => gate } } : {})
  });
  const claimed = vi.spyOn(ctx.state.claims, "set");

  await executeItem(
    ctx,
    fakeItemRow({ artifactKey: "ak-1" }),
    fakePlan(options.maxAttempts ?? 3),
    createDrainController(undefined),
    collectReports().report,
    Promise.resolve()
  );

  const verdict = await claimed.mock.calls[0]?.[1].settled;
  return { verdict, claimsLeft: ctx.state.claims.size };
}

// ---------------------------------------------------------------------------
// executeItem — cross-run dedupe: one item per artifact key reaches the provider
// ---------------------------------------------------------------------------

describe("executeItem — cross-run dedupe claim", () => {
  const LEADER = "leader-item";

  it("waits on the leader's claim and reuses its artifact when it settles done", async () => {
    const log: CallLog = [];
    let artifact: DoneArtifact | undefined;
    const ctx = createFakeRunnerContext(log, {
      journal: { findDoneArtifact: () => artifact },
      store: { has: async () => true }
    });
    const settleLeader = openClaim(ctx.state, "ak-1", LEADER);
    const item = fakeItemRow({ artifactKey: "ak-1" });
    const { report, events } = collectReports();

    const following = executeItem(
      ctx,
      item,
      fakePlan(3),
      createDrainController(undefined),
      report,
      Promise.resolve()
    );
    await flush();
    expect(log).toEqual([]);

    artifact = { contentHash: "hash-leader", mimeType: "video/mp4" };
    settleLeader({ kind: "done" });

    await expect(following).resolves.toBe("settled");
    expect(log).toEqual([`journal.reuseDone(${item.id})`]);
    expect(events).toEqual([
      { type: "item:queued", itemId: item.id, task: item.task, provider: item.provider },
      { type: "item:done", itemId: item.id, costUsd: 0, contentHash: "hash-leader" }
    ]);
    expect(ctx.log.info).toHaveBeenCalledWith("runner:dedupe:wait", {
      itemId: item.id,
      leader: LEADER
    });
  });

  it.each<[string, ClaimVerdict, string, string]>([
    ["flagged", { kind: "flagged" }, "journal.markFlagged(item-1)", "item:flagged"],
    [
      "failed",
      { kind: "failed", errorClass: "http-4xx" },
      "journal.markFailed(item-1,terminal)",
      "item:failed"
    ]
  ])("copies a %s verdict through the gate with no attempt and no lane", async (_name, verdict, journalCall, recordType) => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    const settleLeader = openClaim(ctx.state, "ak-1", LEADER);
    const item = fakeItemRow({ artifactKey: "ak-1" });
    const { report, events } = collectReports();

    const following = executeItem(
      ctx,
      item,
      fakePlan(3),
      createDrainController(undefined),
      report,
      Promise.resolve()
    );
    await flush();
    settleLeader(verdict);

    await expect(following).resolves.toBe("settled");
    expect(log).toEqual([`journal.gateToDispatching(${item.id})`, journalCall]);
    expect(events.map(event => event.type)).toEqual(["item:queued", recordType]);
    expect(events.at(-1)).toMatchObject(
      verdict.kind === "failed" ? { errorClass: verdict.errorClass } : {}
    );
    expect(ctx.log.info).toHaveBeenCalledWith("runner:dedupe:shared", {
      itemId: item.id,
      verdict: verdict.kind
    });
  });

  it("a follower of a failed leader reports the leader's message under its own label", async () => {
    const LEADER_MESSAGE = "[ai] ark rejected the request (400).\n  Check the model id.";
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    const settleLeader = openClaim(ctx.state, "ak-1", LEADER);
    const item = fakeItemRow({ artifactKey: "ak-1", label: "e02.s01.h3" });
    const { report, events } = collectReports();

    const following = executeItem(
      ctx,
      item,
      fakePlan(3),
      createDrainController(undefined),
      report,
      Promise.resolve()
    );
    await flush();
    settleLeader({ kind: "failed", errorClass: "http-4xx", message: LEADER_MESSAGE });
    await following;

    expect(events.at(-1)).toEqual({
      type: "item:failed",
      itemId: item.id,
      label: "e02.s01.h3",
      errorClass: "http-4xx",
      message: LEADER_MESSAGE
    });
    expect(ctx.log.warn).toHaveBeenCalledWith("runner:item:failed", {
      itemId: item.id,
      errorClass: "http-4xx",
      message: LEADER_MESSAGE
    });
  });

  it("a budget refusal while copying a verdict budget-stops the run and records nothing", async () => {
    const log: CallLog = [];
    const gateToDispatching = (itemId: string): GateResult => {
      log.push(`journal.gateToDispatching(${itemId})`);
      return { ok: false, reason: "budget" };
    };
    const ctx = createFakeRunnerContext(log, { journal: { gateToDispatching } });
    const settleLeader = openClaim(ctx.state, "ak-1", LEADER);
    const item = fakeItemRow({ artifactKey: "ak-1" });
    const drain = createDrainController(undefined);
    const { report, events } = collectReports();

    const following = executeItem(ctx, item, fakePlan(3), drain, report, Promise.resolve());
    await flush();
    settleLeader({ kind: "flagged" });
    await following;

    expect(log).toEqual([`journal.gateToDispatching(${item.id})`]);
    expect(drain.budgetStopped).toBe(true);
    expect(events.map(event => event.type)).toEqual(["item:queued"]);
  });

  it("an open verdict makes it the next claimant, and it runs the provider itself", async () => {
    const log: CallLog = [];
    const claimedBy: string[] = [];
    const handler = fakeHandler(log, {
      execute: async () => {
        claimedBy.push(ctx.state.claims.get("ak-1")?.itemId ?? "nobody");
        return { body: new TextEncoder().encode("ok"), mimeType: "text/plain", costUsd: 0.1 };
      }
    });
    const ctx = createFakeRunnerContext(log, { registry: { resolve: (): unknown => handler } });
    const settleLeader = openClaim(ctx.state, "ak-1", LEADER);
    const item = fakeItemRow({ artifactKey: "ak-1" });
    const { report, events } = collectReports();

    const following = executeItem(
      ctx,
      item,
      fakePlan(3),
      createDrainController(undefined),
      report,
      Promise.resolve()
    );
    await flush();
    settleLeader({ kind: "open" });
    await following;

    expect(claimedBy).toEqual([item.id]);
    expect(log).toContain(`journal.commitDone(${item.id})`);
    expect(events.at(-1)?.type).toBe("item:done");
    expect(ctx.state.claims.size).toBe(0);
  });

  it("a done verdict whose bytes left the store is treated as open", async () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log, {
      journal: { findDoneArtifact: () => ({ contentHash: "gone", mimeType: "text/plain" }) },
      store: { has: async () => false }
    });
    const settleLeader = openClaim(ctx.state, "ak-1", LEADER);
    const item = fakeItemRow({ artifactKey: "ak-1" });
    const { report, events } = collectReports();

    const following = executeItem(
      ctx,
      item,
      fakePlan(3),
      createDrainController(undefined),
      report,
      Promise.resolve()
    );
    await flush();
    settleLeader({ kind: "done" });
    await following;

    expect(log).toContain("handler.execute");
    expect(log).not.toContain(`journal.reuseDone(${item.id})`);
    expect(events.at(-1)?.type).toBe("item:done");
  });

  it("an abort while waiting returns settled and leaves the item queued", async () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    openClaim(ctx.state, "ak-1", LEADER);
    const item = fakeItemRow({ artifactKey: "ak-1" });
    const controller = new AbortController();
    const { report, events } = collectReports();

    const following = executeItem(
      ctx,
      item,
      fakePlan(3),
      createDrainController(controller.signal),
      report,
      Promise.resolve()
    );
    await flush();
    controller.abort();

    await expect(following).resolves.toBe("settled");
    expect(log).toEqual([]);
    expect(events.map(event => event.type)).toEqual(["item:queued"]);
    expect(ctx.state.claims.get("ak-1")?.itemId).toBe(LEADER);
  });

  it("an item with no artifact key never claims", async () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    const claimed = vi.spyOn(ctx.state.claims, "set");
    const { report } = collectReports();

    await executeItem(
      ctx,
      fakeItemRow(),
      fakePlan(3),
      createDrainController(undefined),
      report,
      Promise.resolve()
    );

    expect(claimed).not.toHaveBeenCalled();
  });

  describe("the leader settles its own claim with its verdict", () => {
    it("done", async () => {
      expect(await leaderVerdict()).toEqual({ verdict: { kind: "done" }, claimsLeft: 0 });
    });

    it("flagged on a content-policy rejection", async () => {
      const { verdict } = await leaderVerdict({ hint: { kind: "content-policy" } });
      expect(verdict).toEqual({ kind: "flagged" });
    });

    it("failed with the class of a terminal failure", async () => {
      const { verdict } = await leaderVerdict({ hint: { status: 400 } });
      expect(verdict).toEqual({ kind: "failed", errorClass: "http-4xx" });
      expect(verdict).not.toHaveProperty("message");
    });

    it("failed with the message of our own terminal error", async () => {
      const { verdict } = await leaderVerdict({
        hint: { status: 400 },
        message: "[ai] ark rejected the request (400).\n  Check the model id."
      });
      expect(verdict).toEqual({
        kind: "failed",
        errorClass: "http-4xx",
        message: "[ai] ark rejected the request (400).\n  Check the model id."
      });
    });

    it("open once attempts are exhausted on a retryable class, so a follower tries itself", async () => {
      const { verdict } = await leaderVerdict({ hint: { status: 503 }, maxAttempts: 1 });
      expect(verdict).toEqual({ kind: "open" });
    });

    it("open when the gate refuses it", async () => {
      const { verdict } = await leaderVerdict({ gate: { ok: false, reason: "budget" } });
      expect(verdict).toEqual({ kind: "open" });
    });

    it("open when a bug throws, and the error still propagates", async () => {
      const ctx = createFakeRunnerContext([], { registry: { resolve: (): unknown => undefined } });
      const claimed = vi.spyOn(ctx.state.claims, "set");

      await expect(
        executeItem(
          ctx,
          fakeItemRow({ artifactKey: "ak-1" }),
          fakePlan(3),
          createDrainController(undefined),
          collectReports().report,
          Promise.resolve()
        )
      ).rejects.toThrow(/^\[ai\] No executable handler registered/);
      await expect(claimed.mock.calls[0]?.[1].settled).resolves.toEqual({ kind: "open" });
      expect(ctx.state.claims.size).toBe(0);
    });
  });
});

/**
 * A job handler (`submit` + `poll`) whose first job ends `failed` with `error`
 * and whose next job is done. Logs every submit and poll.
 *
 * @param log - Shared call-order log to append to.
 * @param error - The error the first job fails with.
 * @returns The fake job handler.
 * @example
 * ```ts
 * const handler = failFirstJobHandler(log, { kind: "resubmit", status: 503 });
 * ```
 */
function failFirstJobHandler(log: CallLog, error: ProviderErrorHint): ExecutableHandler {
  let submits = 0;
  return {
    estimate: () => ({ usd: 0.1 }),
    submit: async () => {
      submits += 1;
      log.push(`handler.submit(job-${submits})`);
      return { jobId: `job-${submits}` };
    },
    poll: async (jobId): Promise<JobPoll> => {
      log.push(`handler.poll(${jobId})`);
      if (jobId === "job-1") return { state: "failed", error };
      return {
        state: "done",
        video: new TextEncoder().encode("clip"),
        mimeType: "video/mp4",
        costUsd: 0.5
      };
    }
  };
}

/**
 * Runs one job item whose first job fails with `error`, and returns what it logged and reported.
 *
 * @param error - The error the first job fails with.
 * @returns The call log, the stream records and the item id.
 * @example
 * ```ts
 * const { log } = await runFailFirstJob({ status: 503 });
 * ```
 */
async function runFailFirstJob(
  error: ProviderErrorHint
): Promise<{ log: CallLog; events: UnstampedRunEvent[]; itemId: string }> {
  const log: CallLog = [];
  const handler = failFirstJobHandler(log, error);
  const ctx = createFakeRunnerContext(log, {
    config: { retryBaseMs: 1 },
    registry: { resolve: (): unknown => handler }
  });
  const item = fakeItemRow();
  const { report, events } = collectReports();

  await executeItem(
    ctx,
    item,
    fakePlan(3),
    createDrainController(undefined),
    report,
    Promise.resolve()
  );

  return { log, events, itemId: item.id };
}

// ---------------------------------------------------------------------------
// executeItem — a provider's "submit again" verdict retries off the lane breaker
// ---------------------------------------------------------------------------

describe("executeItem — a job failed with kind:resubmit", () => {
  it("re-queues and re-submits, and never reports a retryable-error to the lane breaker", async () => {
    const { log, events, itemId } = await runFailFirstJob({ kind: "resubmit", status: 503 });

    expect(events.map(event => event.type)).toEqual([
      "item:queued",
      "item:dispatching",
      "item:retry",
      "item:dispatching",
      "item:done"
    ]);
    expect(events[2]).toMatchObject({ errorClass: "http-5xx", attempt: 1 });
    expect(log).toContain(`journal.markFailed(${itemId},retry)`);
    expect(log.filter(entry => entry.startsWith("handler.submit"))).toEqual([
      "handler.submit(job-1)",
      "handler.submit(job-2)"
    ]);
    expect(log.filter(entry => entry.startsWith("limits.reportOutcome"))).toEqual([
      "limits.reportOutcome(ok)"
    ]);
  });

  it("a plain 503 job failure still reports a retryable-error to the lane breaker", async () => {
    const { log, events } = await runFailFirstJob({ status: 503 });

    expect(events.at(-1)?.type).toBe("item:done");
    expect(log.filter(entry => entry.startsWith("limits.reportOutcome"))).toEqual([
      "limits.reportOutcome(retryable-error)",
      "limits.reportOutcome(ok)"
    ]);
  });
});

/**
 * Runs one item whose handler throws `failWith(attempt)` on every attempt,
 * and returns what it reported and logged.
 *
 * @param failWith - Builds the error thrown by the given 1-based attempt.
 * @param options - Attempt ceiling and the row's label.
 * @param options.maxAttempts - Attempt ceiling. Default 3.
 * @param options.label - The item row's label. Default the fixture's "01-fakeTask".
 * @returns The context, the stream records and the item id.
 * @example
 * ```ts
 * const { events } = await runFailingItem(() => Object.assign(new Error("[ai] no."), { status: 400 }));
 * ```
 */
async function runFailingItem(
  failWith: (attempt: number) => Error,
  options: { maxAttempts?: number; label?: string | null } = {}
): Promise<{ ctx: RunnerContext; events: UnstampedRunEvent[]; itemId: string }> {
  const log: CallLog = [];
  let attempts = 0;
  const handler = fakeHandler(log, {
    execute: async () => {
      attempts += 1;
      throw failWith(attempts);
    }
  });
  const ctx = createFakeRunnerContext(log, {
    config: { retryBaseMs: 1 },
    registry: { resolve: (): unknown => handler }
  });
  const item = fakeItemRow(options.label === undefined ? {} : { label: options.label });
  const { report, events } = collectReports();

  await executeItem(
    ctx,
    item,
    fakePlan(options.maxAttempts ?? 3),
    createDrainController(undefined),
    report,
    Promise.resolve()
  );

  return { ctx, events, itemId: item.id };
}

// ---------------------------------------------------------------------------
// executeItem — item:failed carries the item's label and our own error's message
// ---------------------------------------------------------------------------

describe("executeItem — item:failed label and message", () => {
  const ARK_MESSAGE = "[ai] ark rejected the request (400).\n  Check the model id.";

  it("a terminal [ai] error reports its first two lines and the item's label", async () => {
    const { ctx, events, itemId } = await runFailingItem(
      () =>
        Object.assign(new Error(`${ARK_MESSAGE}\n  Body: {"code":"InvalidParameter"}`), {
          status: 400
        }),
      { label: "e01.s01.h3" }
    );

    expect(events.at(-1)).toEqual({
      type: "item:failed",
      itemId,
      label: "e01.s01.h3",
      errorClass: "http-4xx",
      message: ARK_MESSAGE
    });
    expect(ctx.log.warn).toHaveBeenCalledWith("runner:item:failed", {
      itemId,
      errorClass: "http-4xx",
      message: ARK_MESSAGE
    });
  });

  it("cuts a long [ai] message at 300 characters", async () => {
    const { events } = await runFailingItem(() =>
      Object.assign(new Error(`[ai] ${"x".repeat(400)}`), { status: 400 })
    );

    const failed = events.at(-1);
    const message = failed?.type === "item:failed" ? failed.message : undefined;
    expect(message).toBe(`[ai] ${"x".repeat(295)}`);
  });

  it("a non-[ai] error reports no message key, only the label", async () => {
    const { ctx, events, itemId } = await runFailingItem(() =>
      Object.assign(new Error("bad request: Authorization Bearer sk-live-123"), { status: 400 })
    );

    const failed = events.at(-1);
    expect(failed).toEqual({
      type: "item:failed",
      itemId,
      label: "01-fakeTask",
      errorClass: "http-4xx"
    });
    expect(failed).not.toHaveProperty("message");
    expect(ctx.log.warn).toHaveBeenCalledWith("runner:item:failed", {
      itemId,
      errorClass: "http-4xx"
    });
    expect(vi.mocked(ctx.log.warn).mock.calls.at(-1)?.[1]).not.toHaveProperty("message");
  });

  it("a row written before labels existed reports label null", async () => {
    // eslint-disable-next-line unicorn/no-null -- ItemRow.label is `string | null` for legacy rows
    const NO_LABEL = null;
    const { events } = await runFailingItem(() => new Error("[ai] no."), { label: NO_LABEL });

    expect(events.at(-1)).toMatchObject({ type: "item:failed", label: NO_LABEL });
  });

  it("retries exhausted: item:failed carries the last attempt's message", async () => {
    const { ctx, events, itemId } = await runFailingItem(
      attempt =>
        Object.assign(new Error(`[ai] fal is busy (attempt ${attempt}).\n  It retries later.`), {
          status: 503
        }),
      { maxAttempts: 2 }
    );

    expect(events.map(event => event.type)).toEqual([
      "item:queued",
      "item:dispatching",
      "item:retry",
      "item:dispatching",
      "item:failed"
    ]);
    expect(events.at(-1)).toEqual({
      type: "item:failed",
      itemId,
      label: "01-fakeTask",
      errorClass: "http-5xx",
      message: "[ai] fal is busy (attempt 2).\n  It retries later."
    });
    expect(ctx.log.warn).toHaveBeenCalledWith("runner:item:failed", {
      itemId,
      errorClass: "http-5xx",
      message: "[ai] fal is busy (attempt 2).\n  It retries later."
    });
  });
});

/**
 * A job handler (`submit` + `poll`) whose `poll` throws `error` for `job-1`
 * and finishes any later job done. Logs every submit and poll.
 *
 * @param log - Shared call-order log to append to.
 * @param error - The error a poll of `job-1` throws.
 * @returns The fake job handler.
 * @example
 * ```ts
 * const handler = throwingPollHandler(log, Object.assign(new Error("[studio] no."), { kind: "local-failure" }));
 * ```
 */
function throwingPollHandler(log: CallLog, error: Error): ExecutableHandler {
  let submits = 0;
  return {
    estimate: () => ({ usd: 0.1 }),
    submit: async () => {
      submits += 1;
      log.push(`handler.submit(job-${submits})`);
      return { jobId: `job-${submits}` };
    },
    poll: async (jobId): Promise<JobPoll> => {
      log.push(`handler.poll(${jobId})`);
      if (jobId === "job-1") throw error;
      return {
        state: "done",
        video: new TextEncoder().encode("clip"),
        mimeType: "video/mp4",
        costUsd: 0.5
      };
    }
  };
}

// ---------------------------------------------------------------------------
// executeItem — invalid-request and local-failure: our own side's verdict
// ---------------------------------------------------------------------------

describe("executeItem — invalid-request and local-failure", () => {
  const OWN_SIDE_KINDS = ["invalid-request", "local-failure"] as const;
  const PUBLIC_MESSAGE = "[studio] Invalid assemble request.\n  Name at least one clip.";

  it.each(
    OWN_SIDE_KINDS
  )("kind:%s fails after one attempt with its class and publicMessage, and no breaker outcome", async kind => {
    const log: CallLog = [];
    let attempts = 0;
    const handler = fakeHandler(log, {
      execute: async () => {
        attempts += 1;
        throw Object.assign(new Error(`${PUBLIC_MESSAGE}\n  ffmpeg: /Users/alex/clip.mp4`), {
          kind,
          status: 503,
          publicMessage: PUBLIC_MESSAGE
        });
      }
    });
    const ctx = createFakeRunnerContext(log, {
      config: { retryBaseMs: 1 },
      registry: { resolve: (): unknown => handler }
    });
    const item = fakeItemRow();
    const { report, events } = collectReports();

    await executeItem(
      ctx,
      item,
      fakePlan(3),
      createDrainController(undefined),
      report,
      Promise.resolve()
    );

    expect(attempts).toBe(1);
    expect(log).toContain("journal.finishAttempt(terminal-error)");
    expect(log).toContain(`journal.markFailed(${item.id},terminal)`);
    expect(log.filter(entry => entry.startsWith("limits.reportOutcome"))).toEqual([]);
    expect(events.at(-1)).toEqual({
      type: "item:failed",
      itemId: item.id,
      label: "01-fakeTask",
      errorClass: kind,
      message: PUBLIC_MESSAGE
    });
  });

  it.each(
    OWN_SIDE_KINDS
  )("a poll that throws kind:%s marks the job expired, not failed, even with a 400", async kind => {
    const log: CallLog = [];
    const error = Object.assign(new Error("[studio] no."), { kind, status: 400 });
    const handler = throwingPollHandler(log, error);
    const ctx = createFakeRunnerContext(log, { registry: { resolve: (): unknown => handler } });
    const { report, events } = collectReports();

    await executeItem(
      ctx,
      fakeItemRow(),
      fakePlan(3),
      createDrainController(undefined),
      report,
      Promise.resolve()
    );

    expect(log.filter(entry => entry.startsWith("journal.setAttemptJob"))).toEqual([
      "journal.setAttemptJob(submitted)",
      "journal.setAttemptJob(expired)"
    ]);
    expect(events.at(-1)).toMatchObject({ type: "item:failed", errorClass: kind });
  });

  it.each(
    OWN_SIDE_KINDS
  )("the first poll of an adopted expired job that throws kind:%s rethrows, with no new submit", async kind => {
    const log: CallLog = [];
    const error = Object.assign(new Error("[studio] no."), { kind, status: 404 });
    const handler = throwingPollHandler(log, error);
    const ctx = createFakeRunnerContext(log, {
      registry: { resolve: (): unknown => handler },
      journal: {
        findLiveJob: () => ({ externalId: "job-1", jobState: "expired", attemptId: 7 })
      }
    });
    const { report, events } = collectReports();

    await executeItem(
      ctx,
      fakeItemRow({ artifactKey: "ak-1" }),
      fakePlan(3),
      createDrainController(undefined),
      report,
      Promise.resolve()
    );

    expect(log.filter(entry => entry.startsWith("handler.submit"))).toEqual([]);
    expect(log).toContain("journal.setAttemptJob(expired)");
    expect(events.at(-1)).toMatchObject({ type: "item:failed", errorClass: kind });
  });
});

// ---------------------------------------------------------------------------
// executeItem — item:flagged carries the provider's safe message
// ---------------------------------------------------------------------------

describe("executeItem — item:flagged message", () => {
  const ARK_FLAGGED =
    "[ai] ark flagged the request: InputImageSensitiveContentDetected.PrivacyInformation.\n  Change the prompt or the inputs.";

  it("a content-policy [ai] error reports its first two lines on item:flagged", async () => {
    const { events, itemId } = await runFailingItem(() =>
      Object.assign(new Error(`${ARK_FLAGGED}\n  Body: {"code":"x"}`), { kind: "content-policy" })
    );

    expect(events.at(-1)).toEqual({ type: "item:flagged", itemId, message: ARK_FLAGGED });
  });

  it("a content-policy error with a publicMessage reports that text", async () => {
    const PUBLIC = "[studio] The portrait was refused.\n  Use another photo.";
    const { events, itemId } = await runFailingItem(() =>
      Object.assign(new Error("raw provider text"), {
        kind: "content-policy",
        publicMessage: PUBLIC
      })
    );

    expect(events.at(-1)).toEqual({ type: "item:flagged", itemId, message: PUBLIC });
  });

  it("a content-policy error with no safe text reports no message key", async () => {
    const { events } = await runFailingItem(() =>
      Object.assign(new Error("flagged content"), { kind: "content-policy" })
    );

    expect(events.at(-1)?.type).toBe("item:flagged");
    expect(events.at(-1)).not.toHaveProperty("message");
  });

  it("the leader settles its claim with the flagged message", async () => {
    const { verdict } = await leaderVerdict({
      hint: { kind: "content-policy" },
      message: ARK_FLAGGED
    });
    expect(verdict).toEqual({ kind: "flagged", message: ARK_FLAGGED });
  });

  it("a follower of a flagged leader reports the leader's message", async () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    const settleLeader = openClaim(ctx.state, "ak-1", "leader-item");
    const item = fakeItemRow({ artifactKey: "ak-1" });
    const { report, events } = collectReports();

    const following = executeItem(
      ctx,
      item,
      fakePlan(3),
      createDrainController(undefined),
      report,
      Promise.resolve()
    );
    await flush();
    settleLeader({ kind: "flagged", message: ARK_FLAGGED });
    await following;

    expect(log).toEqual([
      `journal.gateToDispatching(${item.id})`,
      `journal.markFlagged(${item.id})`
    ]);
    expect(events.at(-1)).toEqual({ type: "item:flagged", itemId: item.id, message: ARK_FLAGGED });
  });
});
