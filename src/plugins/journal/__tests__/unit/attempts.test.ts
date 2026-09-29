import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitDone,
  findDoneArtifact,
  findLiveJob,
  finishAttempt,
  recordAttempt,
  reuseDone
} from "../../attempts";
import type { SqliteDriver } from "../../driver/types";
import { gateToDispatching } from "../../gate";
import { insertItems, listItemsOf } from "../../items";
import { openRun } from "../../runs";
import type { State } from "../../types";
import {
  closeTestJournal,
  intent,
  jobAttempt,
  mustExist,
  openTestJournal,
  queuedItem,
  type TestJournal
} from "./fixtures";

describe("journal attempts", () => {
  let journal: TestJournal;
  let state: State;

  beforeEach(() => {
    journal = openTestJournal();
    state = journal.state;
  });

  afterEach(() => {
    closeTestJournal(journal);
  });

  describe("recordAttempt / finishAttempt", () => {
    it("records an attempt and finishes it with a cost and outcome", () => {
      const run = openRun(state, { glob: "*.yaml" });
      const [item] = insertItems(state, run.id, [intent("pk-1")]);
      const itemId = mustExist(item).id;
      gateToDispatching(state, itemId);

      const attemptId = recordAttempt(state, itemId, {
        provider: "elevenlabs",
        account: "default",
        startedAt: 1
      });
      expect(typeof attemptId).toBe("number");

      expect(() =>
        finishAttempt(state, attemptId, { endedAt: 2, outcome: "done", costUsd: 0.05 })
      ).not.toThrow();
    });

    it("stores the attempt's end, outcome, error class and cost", () => {
      const { itemId } = queuedItem(state);
      const attemptId = recordAttempt(state, itemId, {
        provider: "elevenlabs",
        account: "default",
        startedAt: 1
      });

      finishAttempt(state, attemptId, {
        endedAt: 2,
        outcome: "retryable-error",
        errorClass: "http-5xx"
      });

      const row = journal.driver.get<{
        ended_at: number;
        outcome: string;
        error_class: string | null;
        cost_usd: number | null;
      }>("SELECT ended_at, outcome, error_class, cost_usd FROM attempts WHERE id = ?", [attemptId]);
      expect(row).toMatchObject({
        ended_at: 2,
        outcome: "retryable-error",
        error_class: "http-5xx"
      });
      expect(row?.cost_usd).toBeNull();
    });

    it("returns 0 when the driver reports no inserted row id", () => {
      const driver: SqliteDriver = {
        exec: vi.fn(),
        run: vi.fn(() => ({ changes: 1 })),
        all: vi.fn(() => []),
        get: vi.fn(() => undefined),
        transactionImmediate: vi.fn(fn => fn()),
        close: vi.fn()
      };
      // eslint-disable-next-line unicorn/no-null -- State.checkpointTimer is typed `... | null` (not running)
      const stubState: State = { driver, checkpointTimer: null };

      expect(
        recordAttempt(stubState, "item-1", { provider: "p", account: "a", startedAt: 1 })
      ).toBe(0);
    });
  });

  describe("findLiveJob", () => {
    it("returns a submitted job with its attempt row", () => {
      const attemptId = jobAttempt(state, "req-1", "submitted");
      expect(findLiveJob(state, "ak-pk-1")).toEqual({
        externalId: "req-1",
        jobState: "submitted",
        attemptId
      });
    });

    it("returns an expired job, so a new attempt polls it before submitting", () => {
      const attemptId = jobAttempt(state, "req-1", "expired");
      expect(findLiveJob(state, "ak-pk-1")).toEqual({
        externalId: "req-1",
        jobState: "expired",
        attemptId
      });
    });

    it("skips an expired job a later row marked failed", () => {
      jobAttempt(state, "req-1", "expired");
      jobAttempt(state, "req-1", "failed");
      expect(findLiveJob(state, "ak-pk-1")).toBeUndefined();
    });

    it("skips a job that expired twice", () => {
      jobAttempt(state, "req-1", "expired");
      jobAttempt(state, "req-1", "expired");
      expect(findLiveJob(state, "ak-pk-1")).toBeUndefined();
    });

    it("skips a done job and returns the newest live one", () => {
      jobAttempt(state, "req-1", "done");
      expect(findLiveJob(state, "ak-pk-1")).toBeUndefined();

      const attemptId = jobAttempt(state, "req-2", "submitted");
      expect(findLiveJob(state, "ak-pk-1")?.attemptId).toBe(attemptId);
    });
  });

  describe("commitDone", () => {
    it("transitions dispatching to done with artifact identity", () => {
      const run = openRun(state, { glob: "*.yaml" });
      const [item] = insertItems(state, run.id, [intent("pk-1")]);
      const itemId = mustExist(item).id;
      gateToDispatching(state, itemId);

      commitDone(state, itemId, { actualCostUsd: 0.2, artifactKey: "ak-1", contentHash: "ch-1" });

      const [done] = listItemsOf(state, run.id, { status: "done" });
      expect(mustExist(done).actualCostUsd).toBe(0.2);
      expect(mustExist(done).artifactKey).toBe("ak-1");
      expect(mustExist(done).contentHash).toBe("ch-1");
    });
  });

  describe("findDoneArtifact / reuseDone", () => {
    it("returns undefined for an artifact key that was never built", () => {
      expect(findDoneArtifact(state, "ak-never-built")).toBeUndefined();
    });

    it("finds a done artifact by key and reuses it on a queued item at zero cost", () => {
      const { runId, itemId } = queuedItem(state);
      gateToDispatching(state, itemId);
      commitDone(state, itemId, {
        actualCostUsd: 0.2,
        artifactKey: "ak-1",
        contentHash: "ch-1",
        mimeType: "audio/mpeg"
      });
      const [second] = insertItems(state, runId, [intent("pk-2")]);
      const secondId = mustExist(second).id;

      const artifact = mustExist(findDoneArtifact(state, "ak-1"));
      reuseDone(state, secondId, artifact);

      expect(artifact).toEqual({ contentHash: "ch-1", mimeType: "audio/mpeg" });
      const reused = listItemsOf(state, runId, { status: "done" }).find(row => row.id === secondId);
      expect(mustExist(reused).actualCostUsd).toBe(0);
      expect(mustExist(reused).contentHash).toBe("ch-1");
    });

    it("leaves a non-queued item unchanged", () => {
      const { runId, itemId } = queuedItem(state);
      gateToDispatching(state, itemId);

      reuseDone(state, itemId, { contentHash: "ch-1", mimeType: "audio/mpeg" });

      expect(listItemsOf(state, runId, { status: "dispatching" })).toHaveLength(1);
    });
  });
});
