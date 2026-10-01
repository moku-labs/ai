import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gateToDispatching } from "../../gate";
import {
  buildListItemsQuery,
  getItem,
  insertItems,
  listItemsOf,
  markFailed,
  markFlagged,
  readRecentItems,
  requeueDispatching
} from "../../items";
import { openRun, totalsOf } from "../../runs";
import type { State } from "../../types";
import {
  closeTestJournal,
  intent,
  mustExist,
  openRunAt,
  openTestJournal,
  type TestJournal
} from "./fixtures";

describe("journal items", () => {
  let journal: TestJournal;
  let state: State;

  beforeEach(() => {
    journal = openTestJournal();
    state = journal.state;
  });

  afterEach(() => {
    closeTestJournal(journal);
  });

  describe("insertItems", () => {
    it("is idempotent per (run_id, planning_key)", () => {
      const run = openRun(state, { glob: "*.yaml" });
      const [first] = insertItems(state, run.id, [intent("pk-1")]);
      const [second] = insertItems(state, run.id, [intent("pk-1")]);

      expect(mustExist(second).id).toBe(mustExist(first).id);
      expect(totalsOf(state, run.id).total).toBe(1);
    });

    it("inserts new items as queued with zero attempts", () => {
      const run = openRun(state, { glob: "*.yaml" });
      const [item] = insertItems(state, run.id, [intent("pk-1")]);

      expect(mustExist(item).status).toBe("queued");
      expect(mustExist(item).attemptCount).toBe(0);
      expect(mustExist(item).artifactKey).toBe("ak-pk-1");
      expect(mustExist(item).label).toBe("pk-1");
      expect(mustExist(item).mimeType).toBeNull();
    });

    it("inserts new items with no outputs, and returns the same on a second insert", () => {
      const run = openRun(state, { glob: "*.yaml" });
      const [inserted] = insertItems(state, run.id, [intent("pk-1")]);
      const [existing] = insertItems(state, run.id, [intent("pk-1")]);

      expect(mustExist(inserted).outputs).toBeNull();
      expect(mustExist(existing).outputs).toBeNull();
    });
  });

  describe("requeueDispatching", () => {
    it("requeues every dispatching item of a run and returns the count", () => {
      const run = openRun(state, { glob: "*.yaml" });
      const [a, b] = insertItems(state, run.id, [intent("pk-1"), intent("pk-2")]);
      gateToDispatching(state, mustExist(a).id);
      gateToDispatching(state, mustExist(b).id);

      const count = requeueDispatching(state, run.id);

      expect(count).toBe(2);
      expect(listItemsOf(state, run.id, { status: "queued" })).toHaveLength(2);
      expect(listItemsOf(state, run.id, { status: "dispatching" })).toHaveLength(0);
    });

    it("returns 0 when no items are dispatching", () => {
      const run = openRun(state, { glob: "*.yaml" });

      expect(requeueDispatching(state, run.id)).toBe(0);
    });
  });

  describe("getItem", () => {
    it("returns the item of a run by its planning key", () => {
      const run = openRun(state, { glob: "*.yaml" });
      const [item] = insertItems(state, run.id, [intent("pk-1")]);

      expect(getItem(state, run.id, "pk-1")).toEqual(item);
    });

    it("returns undefined for an unknown planning key", () => {
      const run = openRun(state, { glob: "*.yaml" });

      expect(getItem(state, run.id, "missing")).toBeUndefined();
    });
  });

  describe("markFailed / markFlagged", () => {
    it("terminal markFailed moves the item to failed", () => {
      const run = openRun(state, { glob: "*.yaml" });
      const [item] = insertItems(state, run.id, [intent("pk-1")]);
      const itemId = mustExist(item).id;
      gateToDispatching(state, itemId);

      markFailed(state, itemId, { errorClass: "http-4xx", terminal: true });

      expect(listItemsOf(state, run.id, { status: "failed" })).toHaveLength(1);
    });

    it("retryable markFailed re-queues the item and increments attempt_count", () => {
      const run = openRun(state, { glob: "*.yaml" });
      const [item] = insertItems(state, run.id, [intent("pk-1")]);
      const itemId = mustExist(item).id;
      gateToDispatching(state, itemId);

      markFailed(state, itemId, { errorClass: "http-5xx", terminal: false });

      const [requeued] = listItemsOf(state, run.id, { status: "queued" });
      expect(mustExist(requeued).attemptCount).toBe(1);
    });

    it("markFlagged moves a dispatching item to flagged", () => {
      const run = openRun(state, { glob: "*.yaml" });
      const [item] = insertItems(state, run.id, [intent("pk-1")]);
      const itemId = mustExist(item).id;
      gateToDispatching(state, itemId);

      markFlagged(state, itemId);

      expect(listItemsOf(state, run.id, { status: "flagged" })).toHaveLength(1);
    });
  });

  describe("listItems", () => {
    it("filters by status and respects limit", () => {
      const run = openRun(state, { glob: "*.yaml" });
      insertItems(state, run.id, [intent("pk-1"), intent("pk-2"), intent("pk-3")]);

      expect(listItemsOf(state, run.id, { status: "queued", limit: 2 })).toHaveLength(2);
    });

    it("filters by afterUpdatedAt", () => {
      const run = openRun(state, { glob: "*.yaml" });
      insertItems(state, run.id, [intent("pk-1")]);

      expect(listItemsOf(state, run.id, { afterUpdatedAt: Date.now() + 10_000 })).toHaveLength(0);
    });

    it("builds the unfiltered query with only the run id bound", () => {
      expect(buildListItemsQuery("run-1")).toEqual({
        sql: "SELECT * FROM items WHERE run_id = ? ORDER BY updated_at ASC",
        params: ["run-1"]
      });
    });
  });

  describe("readRecentItems", () => {
    it("returns at most `limit` items of the run, newest-updated first", () => {
      const run = openRun(state, { glob: "*.yaml" });
      const otherRunId = openRunAt(state, 1000, "b/*.yaml");
      insertItems(state, otherRunId, [intent("other")]);
      const [old] = insertItems(state, run.id, [intent("pk-1")]);
      const [newest] = insertItems(state, run.id, [intent("pk-2")]);
      journal.driver.run("UPDATE items SET updated_at = 1 WHERE id = ?", [mustExist(old).id]);

      const recent = readRecentItems(journal.driver, run.id, 1);

      expect(recent.map(item => item.id)).toEqual([mustExist(newest).id]);
    });
  });
});
