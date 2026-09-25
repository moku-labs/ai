import { describe, expect, it, vi } from "vitest";
import type { DoneArtifact, GateResult } from "../../../journal/types";
import {
  artifactKeyOf,
  createDrainController,
  executeItem,
  isExecutableHandler,
  resolveHandler
} from "../../pipeline";
import { openClaim } from "../../state";
import type { ActiveRun, ClaimVerdict, UnstampedRunEvent } from "../../types";
import {
  type CallLog,
  createFakeRunnerContext,
  fakeHandler,
  fakeItemRow,
  fakePlan
} from "./fixtures";

/**
 * Builds a fake `ActiveRun`, for `executeItem` tests (only `inFlight`/`signal`
 * are exercised; the stop controller and settle promise are inert).
 *
 * @param signal - Optional abort signal to attach.
 * @returns A fake active-run record.
 * @example
 * ```ts
 * const active = fakeActiveRun();
 * ```
 */
function fakeActiveRun(signal?: AbortSignal): ActiveRun {
  const { promise, resolve } = Promise.withResolvers<void>();
  return {
    runId: "run-1",
    signal,
    inFlight: 0,
    stop: new AbortController(),
    settled: promise,
    settle: resolve
  };
}

/**
 * Collects every `RunEvent` reported during a test into an array, usable
 * directly as the `report` callback `executeItem` expects.
 *
 * @returns A `report`-shaped function plus the array it appends to.
 * @example
 * ```ts
 * const { report, events } = collectReports();
 * await executeItem(ctx, item, request, 3, drain, active, report);
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
    const active = fakeActiveRun();
    const { report, events } = collectReports();

    await executeItem(ctx, item, fakePlan(3), drain, active, report, Promise.resolve());

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
    const active = fakeActiveRun();
    const { report, events } = collectReports();

    await executeItem(ctx, item, fakePlan(3), drain, active, report, Promise.resolve());

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
    const active = fakeActiveRun();
    const { report } = collectReports();

    await executeItem(ctx, item, fakePlan(3), drain, active, report, Promise.resolve());

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
      const active = fakeActiveRun();
      const { report, events } = collectReports();

      await executeItem(ctx, item, fakePlan(3), drain, active, report, Promise.resolve());

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
      const active = fakeActiveRun();
      const { report, events } = collectReports();

      const startedAt = Date.now();
      await executeItem(ctx, item, fakePlan(3), drain, active, report, Promise.resolve());
      const elapsedMs = Date.now() - startedAt;

      expect(events.at(-1)?.type).toBe("item:done");
      expect(elapsedMs).toBeGreaterThanOrEqual(RETRY_AFTER_MS);
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
      const active = fakeActiveRun();
      const { report, events } = collectReports();

      await executeItem(ctx, item, fakePlan(3), drain, active, report, Promise.resolve());

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
      const active = fakeActiveRun();
      const { report, events } = collectReports();

      await executeItem(ctx, item, fakePlan(3), drain, active, report, Promise.resolve());

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
      const active = fakeActiveRun();
      const { report, events } = collectReports();

      await executeItem(ctx, item, fakePlan(3), drain, active, report, Promise.resolve());

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
      const active = fakeActiveRun();
      const { report, events } = collectReports();

      await executeItem(ctx, item, fakePlan(3), drain, active, report, Promise.resolve());

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
      const active = fakeActiveRun();
      const { report, events } = collectReports();

      await executeItem(ctx, item, fakePlan(2), drain, active, report, Promise.resolve());

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

  describe("abort drain", () => {
    it("admits no items when the drain signal is already aborted", async () => {
      const log: CallLog = [];
      const ctx = createFakeRunnerContext(log);
      const item = fakeItemRow();
      const controller = new AbortController();
      controller.abort();
      const drain = createDrainController(controller.signal);
      const active = fakeActiveRun();
      const { report, events } = collectReports();

      await executeItem(ctx, item, fakePlan(3), drain, active, report, Promise.resolve());

      expect(log).toEqual([]);
      expect(events.map(event => event.type)).toEqual(["item:queued"]);
      expect(active.inFlight).toBe(0);
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
      const active = fakeActiveRun();
      const events: UnstampedRunEvent[] = [];
      // Aborts as soon as the retry is reported — synchronously before the
      // pending `delay()` wait starts, so the wait resolves immediately and
      // the loop exits on its next abort check instead of waiting out the
      // (deliberately huge) retryBaseMs.
      const report = (event: UnstampedRunEvent): void => {
        events.push(event);
        if (event.type === "item:retry") controller.abort();
      };

      await executeItem(ctx, item, fakePlan(3), drain, active, report, Promise.resolve());

      expect(events.map(event => event.type)).toEqual([
        "item:queued",
        "item:dispatching",
        "item:retry"
      ]);
      // Exactly the one in-flight attempt ran to completion; the abort only
      // stopped the NEXT admission, never a second execute() call.
      expect(executeCalls).toBe(1);
      expect(active.inFlight).toBe(0);
    });
  });
});

/**
 * Runs one leader item and returns the verdict its claim settled with.
 *
 * @param options - Handler error hint, attempt ceiling and gate override.
 * @param options.hint - Error fields the handler throws with; omit for success.
 * @param options.maxAttempts - Attempt ceiling. Default 3.
 * @param options.gate - Gate result override.
 * @returns The verdict and whether the claim map is empty afterwards.
 * @example
 * ```ts
 * const { verdict } = await leaderVerdict({ hint: { status: 400 } });
 * ```
 */
async function leaderVerdict(
  options: { hint?: object; maxAttempts?: number; gate?: GateResult } = {}
): Promise<{ verdict: ClaimVerdict | undefined; claimsLeft: number }> {
  const log: CallLog = [];
  const handler = fakeHandler(log, {
    execute: async () => {
      if (options.hint) throw Object.assign(new Error("provider said no"), options.hint);
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
    fakeActiveRun(),
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
      fakeActiveRun(),
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
      fakeActiveRun(),
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

    const following = executeItem(
      ctx,
      item,
      fakePlan(3),
      drain,
      fakeActiveRun(),
      report,
      Promise.resolve()
    );
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
      fakeActiveRun(),
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
      fakeActiveRun(),
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
      fakeActiveRun(),
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
      fakeActiveRun(),
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
          fakeActiveRun(),
          collectReports().report,
          Promise.resolve()
        )
      ).rejects.toThrow(/^\[ai\] No executable handler registered/);
      await expect(claimed.mock.calls[0]?.[1].settled).resolves.toEqual({ kind: "open" });
      expect(ctx.state.claims.size).toBe(0);
    });
  });
});
