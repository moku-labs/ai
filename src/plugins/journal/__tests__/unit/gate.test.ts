import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitDone } from "../../attempts";
import type { ItemDatabaseRow, SqliteDriver } from "../../driver/types";
import { gateToDispatching, isWithinBudget } from "../../gate";
import { insertItems } from "../../items";
import { openRun } from "../../runs";
import type { State } from "../../types";
import {
  closeTestJournal,
  intent,
  mustExist,
  openTestJournal,
  queuedItem,
  type TestJournal
} from "./fixtures";

describe("journal gate", () => {
  let journal: TestJournal;
  let state: State;

  beforeEach(() => {
    journal = openTestJournal();
    state = journal.state;
  });

  afterEach(() => {
    closeTestJournal(journal);
  });

  describe("gateToDispatching — budget boundary", () => {
    it("admits when the projected spend is exactly at the cap", () => {
      const run = openRun(state, { glob: "*.yaml", maxCostUsd: 1 });
      const [item] = insertItems(state, run.id, [intent("pk-1", { estimatedCostUsd: 1 })]);

      expect(gateToDispatching(state, mustExist(item).id)).toEqual({ ok: true });
    });

    it("blocks when the projected spend is one cent over the cap", () => {
      const run = openRun(state, { glob: "*.yaml", maxCostUsd: 1 });
      const [item] = insertItems(state, run.id, [intent("pk-1", { estimatedCostUsd: 1.01 })]);

      expect(gateToDispatching(state, mustExist(item).id)).toEqual({
        ok: false,
        reason: "budget"
      });
    });

    it("accounts for already-dispatching items when checking a second item", () => {
      const run = openRun(state, { glob: "*.yaml", maxCostUsd: 1 });
      const [a, b] = insertItems(state, run.id, [
        intent("pk-1", { estimatedCostUsd: 0.6 }),
        intent("pk-2", { estimatedCostUsd: 0.5 })
      ]);
      expect(gateToDispatching(state, mustExist(a).id)).toEqual({ ok: true });

      expect(gateToDispatching(state, mustExist(b).id)).toEqual({ ok: false, reason: "budget" });
    });

    it("does not gate when there is no budget cap", () => {
      const run = openRun(state, { glob: "*.yaml" });
      const [item] = insertItems(state, run.id, [intent("pk-1", { estimatedCostUsd: 1_000_000 })]);

      expect(gateToDispatching(state, mustExist(item).id)).toEqual({ ok: true });
    });

    it("leaves a budget-blocked item queued", () => {
      const { itemId } = queuedItem(state, { estimatedCostUsd: 2 }, 1);

      gateToDispatching(state, itemId);

      const row = journal.driver.get<{ status: string }>("SELECT status FROM items WHERE id = ?", [
        itemId
      ]);
      expect(row?.status).toBe("queued");
    });
  });

  describe("gateToDispatching — dedup gate", () => {
    it("blocks a second admission attempt of the same item", () => {
      const run = openRun(state, { glob: "*.yaml" });
      const [item] = insertItems(state, run.id, [intent("pk-1")]);
      const itemId = mustExist(item).id;

      expect(gateToDispatching(state, itemId)).toEqual({ ok: true });
      expect(gateToDispatching(state, itemId)).toEqual({ ok: false, reason: "duplicate" });
    });

    it("blocks re-admission once an item is already done", () => {
      const run = openRun(state, { glob: "*.yaml" });
      const [item] = insertItems(state, run.id, [intent("pk-1")]);
      const itemId = mustExist(item).id;
      gateToDispatching(state, itemId);
      commitDone(state, itemId, { actualCostUsd: 0.1, artifactKey: "ak-1", contentHash: "ch-1" });

      expect(gateToDispatching(state, itemId)).toEqual({ ok: false, reason: "duplicate" });
    });
  });

  describe("isWithinBudget", () => {
    it("counts no spend or reservation when the sums return no row", () => {
      const driver: SqliteDriver = {
        exec: vi.fn(),
        run: vi.fn(() => ({ changes: 0 })),
        all: vi.fn(() => []),
        get: vi.fn(() => undefined),
        transactionImmediate: vi.fn(fn => fn()),
        close: vi.fn()
      };
      const { itemId } = queuedItem(state, { estimatedCostUsd: 1 });
      const item = mustExist(
        journal.driver.get<ItemDatabaseRow>("SELECT * FROM items WHERE id = ?", [itemId])
      );

      expect(isWithinBudget(driver, item, 1)).toBe(true);
      expect(isWithinBudget(driver, item, 0.99)).toBe(false);
    });
  });

  describe("gateToDispatching — missing rows", () => {
    it("throws the documented error when the item does not exist", () => {
      expect(() => gateToDispatching(state, "missing-item")).toThrow(
        "[ai] Item not found: missing-item.\n  Verify the item id came from insertItems() for this run."
      );
    });

    it("throws the documented error when the item's run does not exist", () => {
      const { runId, itemId } = queuedItem(state);
      // An orphaned item can only exist with foreign keys off (better-sqlite3 enables them).
      journal.driver.exec("PRAGMA foreign_keys = OFF");
      journal.driver.run("DELETE FROM runs WHERE id = ?", [runId]);

      expect(() => gateToDispatching(state, itemId)).toThrow(
        `[ai] Run not found: ${runId}.\n  Verify the run id came from openRun() for this invocation.`
      );
    });
  });
});
