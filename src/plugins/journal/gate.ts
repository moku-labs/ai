/**
 * @file journal core plugin — the atomic budget + dedup gate: `queued → dispatching` in one
 * write transaction.
 */
import { requireDriver } from "./db";
import type { ItemDatabaseRow, RunDatabaseRow, SqliteDriver } from "./driver/types";
import type { GateResult, State } from "./types";

/**
 * Evaluates the gate's budget check for one item against its run's cap.
 *
 * @param driver - Open SqliteDriver, already inside a write transaction.
 * @param item - The candidate item's raw row.
 * @param maxCostUsd - The run's budget cap, or null when uncapped.
 * @returns True when admitting this item would stay within the cap.
 */
export function isWithinBudget(
  driver: SqliteDriver,
  item: ItemDatabaseRow,
  maxCostUsd: number | null
): boolean {
  if (maxCostUsd === null) {
    return true;
  }

  const spend = driver.get<{ total: number }>(
    "SELECT COALESCE(SUM(actual_cost_usd), 0) AS total FROM items WHERE run_id = ? AND status = 'done'",
    [item.run_id]
  );
  const reserved = driver.get<{ total: number }>(
    "SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total FROM items WHERE run_id = ? AND status = 'dispatching'",
    [item.run_id]
  );
  const projected = (spend?.total ?? 0) + (reserved?.total ?? 0) + item.estimated_cost_usd;

  return projected <= maxCostUsd;
}

/**
 * The atomic budget + dedup gate. In one `BEGIN IMMEDIATE` transaction:
 * verifies the item is still `queued` (otherwise this is a duplicate
 * admission attempt), verifies the projected spend stays within the run's
 * budget cap, then transitions the item `queued → dispatching`.
 *
 * @param state - Journal plugin state.
 * @param itemId - Item id to admit.
 * @returns `{ ok: true }` on admission, or `{ ok: false, reason }` when
 *   blocked by the budget cap or a duplicate admission attempt.
 * @throws {Error} When the item or its run cannot be found.
 */
export function gateToDispatching(state: State, itemId: string): GateResult {
  const driver = requireDriver(state);
  return driver.transactionImmediate<GateResult>(() => {
    const item = driver.get<ItemDatabaseRow>("SELECT * FROM items WHERE id = ?", [itemId]);
    if (!item) {
      throw new Error(
        `[ai] Item not found: ${itemId}.\n  Verify the item id came from insertItems() for this run.`
      );
    }
    // Checked before the budget math: a second gate call on an item that is
    // no longer queued (already dispatching/done/failed/flagged) is a
    // duplicate admission attempt, not a fresh one — and skipping this check
    // first would double-count the item's own reserved estimate.
    if (item.status !== "queued") {
      return { ok: false, reason: "duplicate" };
    }

    const run = driver.get<RunDatabaseRow>("SELECT * FROM runs WHERE id = ?", [item.run_id]);
    if (!run) {
      throw new Error(
        `[ai] Run not found: ${item.run_id}.\n  Verify the run id came from openRun() for this invocation.`
      );
    }
    if (!isWithinBudget(driver, item, run.max_cost_usd)) {
      return { ok: false, reason: "budget" };
    }

    driver.run("UPDATE items SET status = 'dispatching', updated_at = ? WHERE id = ?", [
      Date.now(),
      itemId
    ]);
    return { ok: true };
  });
}
