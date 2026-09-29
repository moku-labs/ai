import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitDone, finishAttempt, recordAttempt } from "../../attempts";
import type { SqliteDriver } from "../../driver/types";
import { gateToDispatching } from "../../gate";
import { insertItems, markFailed } from "../../items";
import {
  getRun,
  latestResumableRun,
  latestRun,
  openRun,
  readRun,
  readTotals,
  setRunStatus,
  totalsOf
} from "../../runs";
import type { State } from "../../types";
import {
  closeTestJournal,
  intent,
  mustExist,
  openRunAt,
  openTestJournal,
  type TestJournal
} from "./fixtures";

/** Records one successful attempt on an admitted item and commits it as done. */
function completeItem(state: State, itemId: string, costUsd: number): void {
  const attemptId = recordAttempt(state, itemId, {
    provider: "elevenlabs",
    account: "default",
    startedAt: 1
  });
  finishAttempt(state, attemptId, { endedAt: 2, outcome: "done", costUsd });
  commitDone(state, itemId, {
    actualCostUsd: costUsd,
    artifactKey: `ak-${itemId}`,
    contentHash: `ch-${itemId}`
  });
}

/** A driver whose every read finds no row, for the defensive `?? 0` fallbacks. */
function emptyReadDriver(): SqliteDriver {
  return {
    exec: vi.fn(),
    run: vi.fn(() => ({ changes: 0 })),
    all: vi.fn(() => []),
    get: vi.fn(() => undefined),
    transactionImmediate: vi.fn(fn => fn()),
    close: vi.fn()
  };
}

describe("journal runs", () => {
  let journal: TestJournal;
  let state: State;

  beforeEach(() => {
    journal = openTestJournal();
    state = journal.state;
  });

  afterEach(() => {
    closeTestJournal(journal);
  });

  describe("openRun / getRun / latestResumableRun", () => {
    it("opens a run with an active status and no budget cap by default", () => {
      const run = openRun(state, { glob: "voice/*.yaml" });

      expect(run.status).toBe("active");
      expect(run.maxCostUsd).toBeNull();
      expect(run.finishedAt).toBeNull();
      expect(getRun(state, run.id)).toEqual(run);
    });

    it("stores the budget cap when one is given", () => {
      const run = openRun(state, { glob: "voice/*.yaml", maxCostUsd: 2.5 });

      expect(run.maxCostUsd).toBe(2.5);
      expect(getRun(state, run.id)?.maxCostUsd).toBe(2.5);
    });

    it("returns undefined for an unknown run id", () => {
      expect(getRun(state, "does-not-exist")).toBeUndefined();
    });

    it("returns the most recently created resumable run", () => {
      const first = openRun(state, { glob: "a/*.yaml" });
      setRunStatus(state, first.id, "done");
      const second = openRun(state, { glob: "b/*.yaml" });

      expect(latestResumableRun(state)?.id).toBe(second.id);
    });

    it("returns undefined when no run is resumable", () => {
      const run = openRun(state, { glob: "a/*.yaml" });
      setRunStatus(state, run.id, "done");

      expect(latestResumableRun(state)).toBeUndefined();
    });

    it("skips excluded runs and returns the next newest resumable run", () => {
      const oldest = openRunAt(state, 1000, "a/*.yaml");
      const middle = openRunAt(state, 2000, "b/*.yaml");
      const newest = openRunAt(state, 3000, "c/*.yaml");
      setRunStatus(state, middle, "paused");

      expect(latestResumableRun(state, { exclude: [newest] })?.id).toBe(middle);
      expect(latestResumableRun(state, { exclude: [newest, middle] })?.id).toBe(oldest);
    });

    it("returns undefined when every resumable run is excluded", () => {
      const first = openRunAt(state, 1000, "a/*.yaml");
      const second = openRunAt(state, 2000, "b/*.yaml");

      expect(latestResumableRun(state, { exclude: [first, second] })).toBeUndefined();
    });

    it("treats an omitted or empty exclude list as no filter", () => {
      openRunAt(state, 1000, "a/*.yaml");
      const newest = openRunAt(state, 2000, "b/*.yaml");

      expect(latestResumableRun(state)?.id).toBe(newest);
      expect(latestResumableRun(state, {})?.id).toBe(newest);
      expect(latestResumableRun(state, { exclude: [] })?.id).toBe(newest);
    });

    it("ignores excluded ids that match no run", () => {
      const newest = openRunAt(state, 1000, "a/*.yaml");

      expect(latestResumableRun(state, { exclude: ["unknown-run"] })?.id).toBe(newest);
    });
  });

  describe("latestRun", () => {
    it("returns undefined when the journal is empty", () => {
      expect(latestRun(state)).toBeUndefined();
    });

    it("returns the newest run of any status", () => {
      openRunAt(state, 1000, "a/*.yaml");
      const newest = openRunAt(state, 2000, "b/*.yaml");
      setRunStatus(state, newest, "failed");

      expect(latestRun(state)?.id).toBe(newest);
    });
  });

  describe("setRunStatus", () => {
    it("records finishedAt for a terminal status", () => {
      const run = openRun(state, { glob: "a/*.yaml" });

      setRunStatus(state, run.id, "done");

      const updated = mustExist(getRun(state, run.id));
      expect(updated.status).toBe("done");
      expect(typeof updated.finishedAt).toBe("number");
    });

    it("leaves finishedAt null for a non-terminal status", () => {
      const run = openRun(state, { glob: "a/*.yaml" });

      setRunStatus(state, run.id, "budget-stopped");

      const updated = mustExist(getRun(state, run.id));
      expect(updated.status).toBe("budget-stopped");
      expect(updated.finishedAt).toBeNull();
    });
  });

  describe("two runs in one process", () => {
    it("keeps per-run totals correct when their writes interleave", () => {
      const runA = openRun(state, { glob: "a/*.yaml", maxCostUsd: 10 });
      const runB = openRun(state, { glob: "b/*.yaml", maxCostUsd: 10 });
      const itemsA = insertItems(state, runA.id, [intent("a-1"), intent("a-2")]);
      const itemsB = insertItems(state, runB.id, [intent("b-1"), intent("b-2")]);
      const [a1, a2] = itemsA.map(item => item.id);
      const [b1, b2] = itemsB.map(item => item.id);

      expect(gateToDispatching(state, mustExist(a1))).toEqual({ ok: true });
      expect(gateToDispatching(state, mustExist(b1))).toEqual({ ok: true });
      expect(gateToDispatching(state, mustExist(a2))).toEqual({ ok: true });
      expect(gateToDispatching(state, mustExist(b2))).toEqual({ ok: true });
      completeItem(state, mustExist(b1), 0.3);
      completeItem(state, mustExist(a1), 0.2);
      markFailed(state, mustExist(b2), { errorClass: "http-4xx", terminal: true });
      completeItem(state, mustExist(a2), 0.5);

      expect(totalsOf(state, runA.id)).toMatchObject({
        total: 2,
        queued: 0,
        dispatching: 0,
        done: 2,
        failed: 0,
        spendUsd: 0.7
      });
      expect(totalsOf(state, runB.id)).toMatchObject({
        total: 2,
        queued: 0,
        dispatching: 0,
        done: 1,
        failed: 1,
        spendUsd: 0.3
      });
    });
  });

  describe("totals", () => {
    it("aggregates counts and spend across statuses", () => {
      const run = openRun(state, { glob: "*.yaml" });
      const [a, b] = insertItems(state, run.id, [
        intent("pk-1", { estimatedCostUsd: 0.5 }),
        intent("pk-2", { estimatedCostUsd: 0.25 }),
        intent("pk-3", { estimatedCostUsd: 0.75 })
      ]);
      const itemAId = mustExist(a).id;
      const itemBId = mustExist(b).id;
      gateToDispatching(state, itemAId);
      commitDone(state, itemAId, { actualCostUsd: 0.4, artifactKey: "ak-1", contentHash: "ch-1" });
      gateToDispatching(state, itemBId);

      const totals = totalsOf(state, run.id);

      expect(totals.total).toBe(3);
      expect(totals.done).toBe(1);
      expect(totals.dispatching).toBe(1);
      expect(totals.queued).toBe(1);
      expect(totals.spendUsd).toBe(0.4);
      expect(totals.estimatedRemainingUsd).toBeCloseTo(0.25 + 0.75, 5);
    });

    it("returns all-zero totals for an empty run", () => {
      const run = openRun(state, { glob: "*.yaml" });

      expect(totalsOf(state, run.id)).toEqual({
        total: 0,
        queued: 0,
        dispatching: 0,
        done: 0,
        failed: 0,
        flagged: 0,
        spendUsd: 0,
        estimatedRemainingUsd: 0
      });
    });
  });

  describe("readRun / readTotals on an arbitrary connection", () => {
    it("reads a run through the driver it is given", () => {
      const run = openRun(state, { glob: "a/*.yaml" });

      expect(readRun(journal.driver, run.id)).toEqual(run);
      expect(readRun(journal.driver, "does-not-exist")).toBeUndefined();
    });

    it("falls back to all-zero totals when the aggregate returns no row", () => {
      expect(readTotals(emptyReadDriver(), "any-run")).toEqual({
        total: 0,
        queued: 0,
        dispatching: 0,
        done: 0,
        failed: 0,
        flagged: 0,
        spendUsd: 0,
        estimatedRemainingUsd: 0
      });
    });
  });
});
