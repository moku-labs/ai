import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJournalApi } from "../../api";
import { openSqliteDriver } from "../../driver/select";
import type { SqliteDriver } from "../../driver/types";
import { createSchema } from "../../schema";
import type { Config, ItemIntent, JournalApi, State } from "../../types";

function intent(planningKey: string, overrides: Partial<ItemIntent> = {}): ItemIntent {
  return {
    planningKey,
    buildFile: "voice.build.yaml",
    task: "voiceover",
    provider: "elevenlabs",
    // eslint-disable-next-line unicorn/no-null -- ItemIntent.packVersion is typed `string | null`, matching the nullable SQL column
    packVersion: null,
    estimatedCostUsd: 0.1,
    label: planningKey,
    buildName: "voice",
    artifactKey: `ak-${planningKey}`,
    ...overrides
  };
}

/** Narrows a possibly-undefined test fixture value, failing fast if absent. */
function mustExist<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected value to be defined");
  }
  return value;
}

/** Records one attempt on a fresh `pk-1` item and sets its job. */
function jobAttempt(
  api: JournalApi,
  externalId: string,
  jobState: "submitted" | "expired" | "failed" | "done"
): number {
  const run = api.openRun({ glob: "*.yaml" });
  const [item] = api.insertItems(run.id, [intent("pk-1")]);
  const attemptId = api.recordAttempt(mustExist(item).id, {
    provider: "elevenlabs",
    account: "default",
    startedAt: 1
  });
  api.setAttemptJob(attemptId, { externalId, jobState });
  return attemptId;
}

/** Opens a run with a pinned `created_at`, so newest-first order is deterministic. */
function openRunAt(api: JournalApi, createdAt: number, glob: string): string {
  const clock = vi.spyOn(Date, "now").mockReturnValue(createdAt);
  const run = api.openRun({ glob });
  clock.mockRestore();
  return run.id;
}

/** Records one successful attempt on an admitted item and commits it as done. */
function completeItem(api: JournalApi, itemId: string, costUsd: number): void {
  const attemptId = api.recordAttempt(itemId, {
    provider: "elevenlabs",
    account: "default",
    startedAt: 1
  });
  api.finishAttempt(attemptId, { endedAt: 2, outcome: "done", costUsd });
  api.commitDone(itemId, {
    actualCostUsd: costUsd,
    artifactKey: `ak-${itemId}`,
    contentHash: `ch-${itemId}`
  });
}

describe("journal api", () => {
  let dir: string;
  let driver: SqliteDriver;
  let config: Config;
  let state: State;
  let api: JournalApi;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "journal-api-"));
    config = {
      path: path.join(dir, "journal.db"),
      checkpointIntervalMs: 30_000,
      busyTimeoutMs: 5000
    };
    driver = openSqliteDriver({ path: config.path, busyTimeoutMs: config.busyTimeoutMs });
    createSchema(driver);
    // eslint-disable-next-line unicorn/no-null -- State.checkpointTimer is typed `... | null` (not running yet)
    state = { driver, checkpointTimer: null };
    api = createJournalApi({ config, state });
  });

  afterEach(() => {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("not-open guard", () => {
    it("throws the documented error message when the driver is null", () => {
      const closedApi = createJournalApi({
        config,
        // eslint-disable-next-line unicorn/no-null -- State fields are typed `X | null` (not opened yet)
        state: { driver: null, checkpointTimer: null }
      });

      expect(() => closedApi.openRun({ glob: "*.yaml" })).toThrow(
        "[ai] Journal is not open.\n  Call app.start() before using the journal."
      );
    });
  });

  describe("openRun / getRun / latestResumableRun", () => {
    it("opens a run with an active status and no budget cap by default", () => {
      const run = api.openRun({ glob: "voice/*.yaml" });

      expect(run.status).toBe("active");
      expect(run.maxCostUsd).toBeNull();
      expect(run.finishedAt).toBeNull();
      expect(api.getRun(run.id)).toEqual(run);
    });

    it("returns undefined for an unknown run id", () => {
      expect(api.getRun("does-not-exist")).toBeUndefined();
    });

    it("returns the most recently created resumable run", () => {
      const first = api.openRun({ glob: "a/*.yaml" });
      api.setRunStatus(first.id, "done");
      const second = api.openRun({ glob: "b/*.yaml" });

      expect(api.latestResumableRun()?.id).toBe(second.id);
    });

    it("returns undefined when no run is resumable", () => {
      const run = api.openRun({ glob: "a/*.yaml" });
      api.setRunStatus(run.id, "done");

      expect(api.latestResumableRun()).toBeUndefined();
    });

    it("skips excluded runs and returns the next newest resumable run", () => {
      const oldest = openRunAt(api, 1000, "a/*.yaml");
      const middle = openRunAt(api, 2000, "b/*.yaml");
      const newest = openRunAt(api, 3000, "c/*.yaml");
      api.setRunStatus(middle, "paused");

      expect(api.latestResumableRun({ exclude: [newest] })?.id).toBe(middle);
      expect(api.latestResumableRun({ exclude: [newest, middle] })?.id).toBe(oldest);
    });

    it("returns undefined when every resumable run is excluded", () => {
      const first = openRunAt(api, 1000, "a/*.yaml");
      const second = openRunAt(api, 2000, "b/*.yaml");

      expect(api.latestResumableRun({ exclude: [first, second] })).toBeUndefined();
    });

    it("treats an omitted or empty exclude list as no filter", () => {
      openRunAt(api, 1000, "a/*.yaml");
      const newest = openRunAt(api, 2000, "b/*.yaml");

      expect(api.latestResumableRun()?.id).toBe(newest);
      expect(api.latestResumableRun({})?.id).toBe(newest);
      expect(api.latestResumableRun({ exclude: [] })?.id).toBe(newest);
    });

    it("ignores excluded ids that match no run", () => {
      const newest = openRunAt(api, 1000, "a/*.yaml");

      expect(api.latestResumableRun({ exclude: ["unknown-run"] })?.id).toBe(newest);
    });
  });

  describe("two runs in one process", () => {
    it("keeps per-run totals correct when their writes interleave", () => {
      const runA = api.openRun({ glob: "a/*.yaml", maxCostUsd: 10 });
      const runB = api.openRun({ glob: "b/*.yaml", maxCostUsd: 10 });
      const itemsA = api.insertItems(runA.id, [intent("a-1"), intent("a-2")]);
      const itemsB = api.insertItems(runB.id, [intent("b-1"), intent("b-2")]);
      const [a1, a2] = itemsA.map(item => item.id);
      const [b1, b2] = itemsB.map(item => item.id);

      expect(api.gateToDispatching(mustExist(a1))).toEqual({ ok: true });
      expect(api.gateToDispatching(mustExist(b1))).toEqual({ ok: true });
      expect(api.gateToDispatching(mustExist(a2))).toEqual({ ok: true });
      expect(api.gateToDispatching(mustExist(b2))).toEqual({ ok: true });
      completeItem(api, mustExist(b1), 0.3);
      completeItem(api, mustExist(a1), 0.2);
      api.markFailed(mustExist(b2), { errorClass: "http-4xx", terminal: true });
      completeItem(api, mustExist(a2), 0.5);

      expect(api.totals(runA.id)).toMatchObject({
        total: 2,
        queued: 0,
        dispatching: 0,
        done: 2,
        failed: 0,
        spendUsd: 0.7
      });
      expect(api.totals(runB.id)).toMatchObject({
        total: 2,
        queued: 0,
        dispatching: 0,
        done: 1,
        failed: 1,
        spendUsd: 0.3
      });
    });
  });

  describe("insertItems", () => {
    it("is idempotent per (run_id, planning_key)", () => {
      const run = api.openRun({ glob: "*.yaml" });
      const [first] = api.insertItems(run.id, [intent("pk-1")]);
      const [second] = api.insertItems(run.id, [intent("pk-1")]);

      expect(mustExist(second).id).toBe(mustExist(first).id);
      expect(api.totals(run.id).total).toBe(1);
    });

    it("inserts new items as queued with zero attempts", () => {
      const run = api.openRun({ glob: "*.yaml" });
      const [item] = api.insertItems(run.id, [intent("pk-1")]);

      expect(mustExist(item).status).toBe("queued");
      expect(mustExist(item).attemptCount).toBe(0);
      expect(mustExist(item).artifactKey).toBe("ak-pk-1");
      expect(mustExist(item).label).toBe("pk-1");
      expect(mustExist(item).mimeType).toBeNull();
    });
  });

  describe("requeueDispatching", () => {
    it("requeues every dispatching item of a run and returns the count", () => {
      const run = api.openRun({ glob: "*.yaml" });
      const [a, b] = api.insertItems(run.id, [intent("pk-1"), intent("pk-2")]);
      api.gateToDispatching(mustExist(a).id);
      api.gateToDispatching(mustExist(b).id);

      const count = api.requeueDispatching(run.id);

      expect(count).toBe(2);
      expect(api.listItems(run.id, { status: "queued" })).toHaveLength(2);
      expect(api.listItems(run.id, { status: "dispatching" })).toHaveLength(0);
    });

    it("returns 0 when no items are dispatching", () => {
      const run = api.openRun({ glob: "*.yaml" });

      expect(api.requeueDispatching(run.id)).toBe(0);
    });
  });

  describe("gateToDispatching — budget boundary", () => {
    it("admits when the projected spend is exactly at the cap", () => {
      const run = api.openRun({ glob: "*.yaml", maxCostUsd: 1 });
      const [item] = api.insertItems(run.id, [intent("pk-1", { estimatedCostUsd: 1 })]);

      expect(api.gateToDispatching(mustExist(item).id)).toEqual({ ok: true });
    });

    it("blocks when the projected spend is one cent over the cap", () => {
      const run = api.openRun({ glob: "*.yaml", maxCostUsd: 1 });
      const [item] = api.insertItems(run.id, [intent("pk-1", { estimatedCostUsd: 1.01 })]);

      expect(api.gateToDispatching(mustExist(item).id)).toEqual({ ok: false, reason: "budget" });
    });

    it("accounts for already-dispatching items when checking a second item", () => {
      const run = api.openRun({ glob: "*.yaml", maxCostUsd: 1 });
      const [a, b] = api.insertItems(run.id, [
        intent("pk-1", { estimatedCostUsd: 0.6 }),
        intent("pk-2", { estimatedCostUsd: 0.5 })
      ]);
      expect(api.gateToDispatching(mustExist(a).id)).toEqual({ ok: true });

      expect(api.gateToDispatching(mustExist(b).id)).toEqual({ ok: false, reason: "budget" });
    });

    it("does not gate when there is no budget cap", () => {
      const run = api.openRun({ glob: "*.yaml" });
      const [item] = api.insertItems(run.id, [intent("pk-1", { estimatedCostUsd: 1_000_000 })]);

      expect(api.gateToDispatching(mustExist(item).id)).toEqual({ ok: true });
    });
  });

  describe("gateToDispatching — dedup gate", () => {
    it("blocks a second admission attempt of the same item", () => {
      const run = api.openRun({ glob: "*.yaml" });
      const [item] = api.insertItems(run.id, [intent("pk-1")]);
      const itemId = mustExist(item).id;

      expect(api.gateToDispatching(itemId)).toEqual({ ok: true });
      expect(api.gateToDispatching(itemId)).toEqual({ ok: false, reason: "duplicate" });
    });

    it("blocks re-admission once an item is already done", () => {
      const run = api.openRun({ glob: "*.yaml" });
      const [item] = api.insertItems(run.id, [intent("pk-1")]);
      const itemId = mustExist(item).id;
      api.gateToDispatching(itemId);
      api.commitDone(itemId, { actualCostUsd: 0.1, artifactKey: "ak-1", contentHash: "ch-1" });

      expect(api.gateToDispatching(itemId)).toEqual({ ok: false, reason: "duplicate" });
    });
  });

  describe("recordAttempt / finishAttempt", () => {
    it("records an attempt and finishes it with a cost and outcome", () => {
      const run = api.openRun({ glob: "*.yaml" });
      const [item] = api.insertItems(run.id, [intent("pk-1")]);
      const itemId = mustExist(item).id;
      api.gateToDispatching(itemId);

      const attemptId = api.recordAttempt(itemId, {
        provider: "elevenlabs",
        account: "default",
        startedAt: 1
      });
      expect(typeof attemptId).toBe("number");

      expect(() =>
        api.finishAttempt(attemptId, { endedAt: 2, outcome: "done", costUsd: 0.05 })
      ).not.toThrow();
    });
  });

  describe("findLiveJob", () => {
    it("returns a submitted job with its attempt row", () => {
      const attemptId = jobAttempt(api, "req-1", "submitted");
      expect(api.findLiveJob("ak-pk-1")).toEqual({
        externalId: "req-1",
        jobState: "submitted",
        attemptId
      });
    });

    it("returns an expired job, so a new attempt polls it before submitting", () => {
      const attemptId = jobAttempt(api, "req-1", "expired");
      expect(api.findLiveJob("ak-pk-1")).toEqual({
        externalId: "req-1",
        jobState: "expired",
        attemptId
      });
    });

    it("skips an expired job a later row marked failed", () => {
      jobAttempt(api, "req-1", "expired");
      jobAttempt(api, "req-1", "failed");
      expect(api.findLiveJob("ak-pk-1")).toBeUndefined();
    });

    it("skips a job that expired twice", () => {
      jobAttempt(api, "req-1", "expired");
      jobAttempt(api, "req-1", "expired");
      expect(api.findLiveJob("ak-pk-1")).toBeUndefined();
    });

    it("skips a done job and returns the newest live one", () => {
      jobAttempt(api, "req-1", "done");
      expect(api.findLiveJob("ak-pk-1")).toBeUndefined();

      const attemptId = jobAttempt(api, "req-2", "submitted");
      expect(api.findLiveJob("ak-pk-1")?.attemptId).toBe(attemptId);
    });
  });

  describe("commitDone / markFailed / markFlagged", () => {
    it("transitions dispatching to done with artifact identity", () => {
      const run = api.openRun({ glob: "*.yaml" });
      const [item] = api.insertItems(run.id, [intent("pk-1")]);
      const itemId = mustExist(item).id;
      api.gateToDispatching(itemId);

      api.commitDone(itemId, { actualCostUsd: 0.2, artifactKey: "ak-1", contentHash: "ch-1" });

      const [done] = api.listItems(run.id, { status: "done" });
      expect(mustExist(done).actualCostUsd).toBe(0.2);
      expect(mustExist(done).artifactKey).toBe("ak-1");
      expect(mustExist(done).contentHash).toBe("ch-1");
    });

    it("terminal markFailed moves the item to failed", () => {
      const run = api.openRun({ glob: "*.yaml" });
      const [item] = api.insertItems(run.id, [intent("pk-1")]);
      const itemId = mustExist(item).id;
      api.gateToDispatching(itemId);

      api.markFailed(itemId, { errorClass: "http-4xx", terminal: true });

      expect(api.listItems(run.id, { status: "failed" })).toHaveLength(1);
    });

    it("retryable markFailed re-queues the item and increments attempt_count", () => {
      const run = api.openRun({ glob: "*.yaml" });
      const [item] = api.insertItems(run.id, [intent("pk-1")]);
      const itemId = mustExist(item).id;
      api.gateToDispatching(itemId);

      api.markFailed(itemId, { errorClass: "http-5xx", terminal: false });

      const [requeued] = api.listItems(run.id, { status: "queued" });
      expect(mustExist(requeued).attemptCount).toBe(1);
    });

    it("markFlagged moves a dispatching item to flagged", () => {
      const run = api.openRun({ glob: "*.yaml" });
      const [item] = api.insertItems(run.id, [intent("pk-1")]);
      const itemId = mustExist(item).id;
      api.gateToDispatching(itemId);

      api.markFlagged(itemId);

      expect(api.listItems(run.id, { status: "flagged" })).toHaveLength(1);
    });
  });

  describe("totals", () => {
    it("aggregates counts and spend across statuses", () => {
      const run = api.openRun({ glob: "*.yaml" });
      const [a, b] = api.insertItems(run.id, [
        intent("pk-1", { estimatedCostUsd: 0.5 }),
        intent("pk-2", { estimatedCostUsd: 0.25 }),
        intent("pk-3", { estimatedCostUsd: 0.75 })
      ]);
      const itemAId = mustExist(a).id;
      const itemBId = mustExist(b).id;
      api.gateToDispatching(itemAId);
      api.commitDone(itemAId, { actualCostUsd: 0.4, artifactKey: "ak-1", contentHash: "ch-1" });
      api.gateToDispatching(itemBId);

      const totals = api.totals(run.id);

      expect(totals.total).toBe(3);
      expect(totals.done).toBe(1);
      expect(totals.dispatching).toBe(1);
      expect(totals.queued).toBe(1);
      expect(totals.spendUsd).toBe(0.4);
      expect(totals.estimatedRemainingUsd).toBeCloseTo(0.25 + 0.75, 5);
    });

    it("returns all-zero totals for an empty run", () => {
      const run = api.openRun({ glob: "*.yaml" });

      expect(api.totals(run.id)).toEqual({
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

  describe("listItems", () => {
    it("filters by status and respects limit", () => {
      const run = api.openRun({ glob: "*.yaml" });
      api.insertItems(run.id, [intent("pk-1"), intent("pk-2"), intent("pk-3")]);

      expect(api.listItems(run.id, { status: "queued", limit: 2 })).toHaveLength(2);
    });

    it("filters by afterUpdatedAt", () => {
      const run = api.openRun({ glob: "*.yaml" });
      api.insertItems(run.id, [intent("pk-1")]);

      expect(api.listItems(run.id, { afterUpdatedAt: Date.now() + 10_000 })).toHaveLength(0);
    });
  });

  describe("readSnapshot", () => {
    it("opens a second connection and reads committed rows", () => {
      const run = api.openRun({ glob: "*.yaml" });
      api.insertItems(run.id, [intent("pk-1")]);

      const snapshot = api.readSnapshot(run.id);

      expect(snapshot.run.id).toBe(run.id);
      expect(snapshot.totals.total).toBe(1);
      expect(snapshot.recentItems).toHaveLength(1);
    });

    it("throws when the run does not exist", () => {
      expect(() => api.readSnapshot("missing-run")).toThrow();
    });
  });

  describe("checkpoint", () => {
    it("runs without throwing", () => {
      expect(() => api.checkpoint()).not.toThrow();
    });
  });
});
