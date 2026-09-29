/**
 * @file journal core plugin — `items` rows: idempotent insert, requeue, lookup, listing and the
 * failed/flagged transitions.
 */
import { mapItem, requireDriver, SQL_NULL } from "./db";
import type { ItemDatabaseRow, SqliteDriver } from "./driver/types";
import type { ErrorClass, ItemFilter, ItemIntent, ItemRow, State } from "./types";

/**
 * Reads the most recently updated items of a run on an arbitrary driver
 * connection, for `readSnapshot`.
 *
 * @param driver - Any open SqliteDriver (primary or short-lived).
 * @param runId - Run id to read.
 * @param limit - Maximum number of rows to return.
 * @returns The most recently updated items, newest first.
 */
export function readRecentItems(driver: SqliteDriver, runId: string, limit: number): ItemRow[] {
  return driver
    .all<ItemDatabaseRow>("SELECT * FROM items WHERE run_id = ? ORDER BY updated_at DESC LIMIT ?", [
      runId,
      limit
    ])
    .map(row => mapItem(row));
}

/**
 * Builds the parameterized SQL for `listItems`, applying the optional
 * status/limit/afterUpdatedAt filter.
 *
 * @param runId - Run id to filter by.
 * @param filter - Optional status/limit/afterUpdatedAt filter.
 * @returns The SQL text and its bound parameters.
 */
export function buildListItemsQuery(
  runId: string,
  filter?: ItemFilter
): { sql: string; params: (string | number)[] } {
  const params: (string | number)[] = [runId];
  let sql = "SELECT * FROM items WHERE run_id = ?";

  if (filter?.status) {
    sql += " AND status = ?";
    params.push(filter.status);
  }
  if (filter?.afterUpdatedAt !== undefined) {
    sql += " AND updated_at > ?";
    params.push(filter.afterUpdatedAt);
  }
  sql += " ORDER BY updated_at ASC";
  if (filter?.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(filter.limit);
  }

  return { sql, params };
}

/**
 * Inserts one item intent if its planning key is new for this run, or
 * returns the existing row unchanged (the idempotent resume path).
 *
 * @param driver - Open SqliteDriver, already inside a write transaction.
 * @param runId - Run id the item belongs to.
 * @param item - Planning-time intent for the item.
 * @param now - Current time (ms epoch), used as `updated_at` for new rows.
 * @returns The existing or newly inserted item row.
 */
export function insertOneItem(
  driver: SqliteDriver,
  runId: string,
  item: ItemIntent,
  now: number
): ItemRow {
  const existing = driver.get<ItemDatabaseRow>(
    "SELECT * FROM items WHERE run_id = ? AND planning_key = ?",
    [runId, item.planningKey]
  );
  if (existing) {
    return mapItem(existing);
  }

  const id = crypto.randomUUID();
  driver.run(
    `INSERT INTO items
       (id, run_id, build_file, planning_key, task, provider, pack_version, artifact_key, label, build_name, status, estimated_cost_usd, attempt_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?)`,
    [
      id,
      runId,
      item.buildFile,
      item.planningKey,
      item.task,
      item.provider,
      item.packVersion,
      item.artifactKey,
      item.label,
      item.buildName,
      item.estimatedCostUsd,
      now
    ]
  );

  return {
    id,
    runId,
    buildFile: item.buildFile,
    planningKey: item.planningKey,
    task: item.task,
    provider: item.provider,
    packVersion: item.packVersion,
    estimatedCostUsd: item.estimatedCostUsd,
    status: "queued",
    artifactKey: item.artifactKey,
    label: item.label,
    buildName: item.buildName,
    mimeType: SQL_NULL,
    contentHash: SQL_NULL,
    actualCostUsd: SQL_NULL,
    attemptCount: 0,
    updatedAt: now
  };
}

/**
 * Inserts planning-time item intents as `queued`, idempotent per
 * (run_id, planning_key) — re-inserting an existing key is a no-op that
 * returns the existing row (the resume path).
 *
 * @param state - Journal plugin state.
 * @param runId - Run id the items belong to.
 * @param items - Planning-time item intents.
 * @returns The existing or newly inserted item rows, in input order.
 */
export function insertItems(state: State, runId: string, items: ItemIntent[]): ItemRow[] {
  const driver = requireDriver(state);
  return driver.transactionImmediate<ItemRow[]>(() => {
    const now = Date.now();
    return items.map(item => insertOneItem(driver, runId, item, now));
  });
}

/**
 * Unconditionally re-queues every `dispatching` item of a run (no
 * lease/heartbeat), for `resume`.
 *
 * @param state - Journal plugin state.
 * @param runId - Run id to requeue.
 * @returns The number of items requeued.
 */
export function requeueDispatching(state: State, runId: string): number {
  const driver = requireDriver(state);
  return driver.transactionImmediate<number>(() => {
    const result = driver.run(
      "UPDATE items SET status = 'queued', updated_at = ? WHERE run_id = ? AND status = 'dispatching'",
      [Date.now(), runId]
    );
    return result.changes;
  });
}

/**
 * Looks up one item of a run by its planning key.
 *
 * @param state - Journal plugin state.
 * @param runId - Run id the item belongs to.
 * @param planningKey - The item's planning key.
 * @returns The item row, or undefined.
 */
export function getItem(state: State, runId: string, planningKey: string): ItemRow | undefined {
  const driver = requireDriver(state);
  const row = driver.get<ItemDatabaseRow>(
    "SELECT * FROM items WHERE run_id = ? AND planning_key = ?",
    [runId, planningKey]
  );
  return row ? mapItem(row) : undefined;
}

/**
 * Lists a run's items, optionally filtered by status, capped by limit, or
 * paged by `afterUpdatedAt`.
 *
 * @param state - Journal plugin state.
 * @param runId - Run id to list.
 * @param filter - Optional status/limit/afterUpdatedAt filter.
 * @returns The matching items, oldest-updated first.
 */
export function listItemsOf(state: State, runId: string, filter?: ItemFilter): ItemRow[] {
  const driver = requireDriver(state);
  const { sql, params } = buildListItemsQuery(runId, filter);
  return driver.all<ItemDatabaseRow>(sql, params).map(row => mapItem(row));
}

/**
 * Transitions an item `dispatching → failed` (terminal), or back to
 * `queued` with `attempt_count` incremented (retryable).
 *
 * @param state - Journal plugin state.
 * @param itemId - Item id that failed.
 * @param result - The error class and whether it is terminal.
 * @param result.errorClass - Classification of the failure.
 * @param result.terminal - True for a terminal failure; false to retry (re-queue).
 */
export function markFailed(
  state: State,
  itemId: string,
  result: { errorClass: ErrorClass; terminal: boolean }
): void {
  const driver = requireDriver(state);
  driver.transactionImmediate<void>(() => {
    if (result.terminal) {
      driver.run(
        "UPDATE items SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'dispatching'",
        [Date.now(), itemId]
      );
      return;
    }
    driver.run(
      "UPDATE items SET status = 'queued', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND status = 'dispatching'",
      [Date.now(), itemId]
    );
  });
}

/**
 * Transitions an item `dispatching → flagged` — a terminal content-policy
 * state that is never re-queued.
 *
 * @param state - Journal plugin state.
 * @param itemId - Item id to flag.
 */
export function markFlagged(state: State, itemId: string): void {
  const driver = requireDriver(state);
  driver.transactionImmediate<void>(() => {
    driver.run(
      "UPDATE items SET status = 'flagged', updated_at = ? WHERE id = ? AND status = 'dispatching'",
      [Date.now(), itemId]
    );
  });
}
