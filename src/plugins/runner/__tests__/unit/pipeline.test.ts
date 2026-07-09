import { describe, expect, it } from "vitest";
import type { GateResult } from "../../../journal/types";
import {
  artifactKeyOf,
  createDrainController,
  executeItem,
  isExecutableHandler,
  resolveHandler
} from "../../pipeline";
import type { ActiveRun, RunEvent } from "../../types";
import { type CallLog, createFakeRunnerContext, fakeHandler, fakeItemRow } from "./fixtures";

/**
 * Builds a fake `ActiveRun` with an empty subscriber set, for `executeItem`
 * tests (only `inFlight`/`signal` are exercised).
 *
 * @param signal - Optional abort signal to attach.
 * @returns A fake active-run record.
 * @example
 * ```ts
 * const active = fakeActiveRun();
 * ```
 */
function fakeActiveRun(signal?: AbortSignal): ActiveRun {
  return { runId: "run-1", signal, subscribers: new Set(), inFlight: 0 };
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
function collectReports(): { report: (event: RunEvent) => void; events: RunEvent[] } {
  const events: RunEvent[] = [];
  return {
    report: (event: RunEvent): void => {
      events.push(event);
    },
    events
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
    const active = fakeActiveRun();
    const { report, events } = collectReports();

    await executeItem(ctx, item, { input: {}, params: {} }, 3, drain, active, report);

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

    await executeItem(ctx, item, { input: {}, params: {} }, 3, drain, active, report);

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

    await executeItem(ctx, item, { input: {}, params: {} }, 3, drain, active, report);

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

      await executeItem(ctx, item, { input: {}, params: {} }, 3, drain, active, report);

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
      await executeItem(ctx, item, { input: {}, params: {} }, 3, drain, active, report);
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

      await executeItem(ctx, item, { input: {}, params: {} }, 3, drain, active, report);

      expect(events.at(-1)?.type).toBe("item:done");
    });

    it("retries a network failure", async () => {
      const log: CallLog = [];
      let executeCalls = 0;
      const handler = fakeHandler(log, {
        execute: async () => {
          executeCalls += 1;
          if (executeCalls === 1) {
            throw new Error("dns failure");
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

      await executeItem(ctx, item, { input: {}, params: {} }, 3, drain, active, report);

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

      await executeItem(ctx, item, { input: {}, params: {} }, 3, drain, active, report);

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

      await executeItem(ctx, item, { input: {}, params: {} }, 3, drain, active, report);

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

      await executeItem(ctx, item, { input: {}, params: {} }, 2, drain, active, report);

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

      await executeItem(ctx, item, { input: {}, params: {} }, 3, drain, active, report);

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
      const events: RunEvent[] = [];
      // Aborts as soon as the retry is reported — synchronously before the
      // pending `delay()` wait starts, so the wait resolves immediately and
      // the loop exits on its next abort check instead of waiting out the
      // (deliberately huge) retryBaseMs.
      const report = (event: RunEvent): void => {
        events.push(event);
        if (event.type === "item:retry") controller.abort();
      };

      await executeItem(ctx, item, { input: {}, params: {} }, 3, drain, active, report);

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
