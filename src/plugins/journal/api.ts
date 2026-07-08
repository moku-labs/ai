/**
 * @file journal core plugin — API factory: run/item/attempt state machine,
 * the atomic budget+dedup gate, aggregates, and the short-lived read-snapshot
 * helper. Metadata only — no free-form payload columns anywhere in this file.
 */
import type { CorePluginContext } from "@moku-labs/core";
import { openSqliteDriver } from "./driver/select";
import type { SqliteDriver } from "./driver/types";
import type {
  AttemptEnd,
  AttemptStart,
  Config,
  ErrorClass,
  GateResult,
  ItemFilter,
  ItemIntent,
  ItemRow,
  ItemStatus,
  JournalApi,
  RunRow,
  RunSnapshot,
  RunStatus,
  RunTotals,
  State
} from "./types";

const NOT_OPEN_ERROR = "[ai] Journal is not open.\n  Call app.start() before using the journal.";
const RECENT_ITEMS_LIMIT = 20;

/**
 * Reusable `null` sentinel. TS's `X | null` row fields (matching SQL's
 * NULL) and SQLite bind parameters both need a literal `null` — never
 * `undefined`, since better-sqlite3/bun:sqlite throw on an `undefined`
 * bind parameter. Centralizing the literal here keeps the `no-null` lint
 * exception to this one line instead of one per call site.
 */
// eslint-disable-next-line unicorn/no-null -- see comment above; the single source of the null literal for this file
const SQL_NULL = null;

/** Raw `items` row shape, matching the SQL schema column-for-column. */
type ItemDatabaseRow = {
  id: string;
  run_id: string;
  build_file: string;
  planning_key: string;
  task: string;
  provider: string;
  pack_version: string | null;
  artifact_key: string | null;
  content_hash: string | null;
  status: ItemStatus;
  estimated_cost_usd: number;
  actual_cost_usd: number | null;
  attempt_count: number;
  updated_at: number;
};

/** Raw `runs` row shape, matching the SQL schema column-for-column. */
type RunDatabaseRow = {
  id: string;
  created_at: number;
  status: RunStatus;
  glob: string;
  max_cost_usd: number | null;
  finished_at: number | null;
};

/**
 * Maps a raw `items` row to the public, camelCase `ItemRow` shape.
 *
 * @param row - Raw database row.
 * @returns The public item representation.
 * @example
 * ```ts
 * const item = mapItem(row);
 * ```
 */
function mapItem(row: ItemDatabaseRow): ItemRow {
  return {
    id: row.id,
    runId: row.run_id,
    buildFile: row.build_file,
    planningKey: row.planning_key,
    task: row.task,
    provider: row.provider,
    packVersion: row.pack_version,
    artifactKey: row.artifact_key,
    contentHash: row.content_hash,
    status: row.status,
    estimatedCostUsd: row.estimated_cost_usd,
    actualCostUsd: row.actual_cost_usd,
    attemptCount: row.attempt_count,
    updatedAt: row.updated_at
  };
}

/**
 * Maps a raw `runs` row to the public, camelCase `RunRow` shape.
 *
 * @param row - Raw database row.
 * @returns The public run representation.
 * @example
 * ```ts
 * const run = mapRun(row);
 * ```
 */
function mapRun(row: RunDatabaseRow): RunRow {
  return {
    id: row.id,
    createdAt: row.created_at,
    status: row.status,
    glob: row.glob,
    maxCostUsd: row.max_cost_usd,
    finishedAt: row.finished_at
  };
}

/**
 * Returns the open driver, or throws the documented not-open error.
 *
 * @param state - Journal plugin state.
 * @returns The open SqliteDriver.
 * @throws {Error} When `onStart` has not run yet (driver is null).
 * @example
 * ```ts
 * const driver = requireDriver(state);
 * ```
 */
function requireDriver(state: State): SqliteDriver {
  if (!state.driver) {
    throw new Error(NOT_OPEN_ERROR);
  }
  return state.driver;
}

/**
 * Reads one run row on an arbitrary driver connection.
 *
 * @param driver - Any open SqliteDriver (primary or short-lived).
 * @param runId - Run id to look up.
 * @returns The run row, or undefined if not found.
 * @example
 * ```ts
 * const run = readRun(driver, runId);
 * ```
 */
function readRun(driver: SqliteDriver, runId: string): RunRow | undefined {
  const row = driver.get<RunDatabaseRow>("SELECT * FROM runs WHERE id = ?", [runId]);
  return row ? mapRun(row) : undefined;
}

/**
 * Computes run totals on an arbitrary driver connection.
 *
 * @param driver - Any open SqliteDriver (primary or short-lived).
 * @param runId - Run id to aggregate.
 * @returns Aggregate counts and spend for the run.
 * @example
 * ```ts
 * const totals = readTotals(driver, runId);
 * ```
 */
function readTotals(driver: SqliteDriver, runId: string): RunTotals {
  const row = driver.get<{
    total: number;
    queued: number;
    dispatching: number;
    done: number;
    failed: number;
    flagged: number;
    spend_usd: number;
    estimated_remaining_usd: number;
  }>(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
       COALESCE(SUM(CASE WHEN status = 'dispatching' THEN 1 ELSE 0 END), 0) AS dispatching,
       COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done,
       COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
       COALESCE(SUM(CASE WHEN status = 'flagged' THEN 1 ELSE 0 END), 0) AS flagged,
       COALESCE(SUM(CASE WHEN status = 'done' THEN actual_cost_usd ELSE 0 END), 0) AS spend_usd,
       COALESCE(SUM(CASE WHEN status IN ('queued', 'dispatching') THEN estimated_cost_usd ELSE 0 END), 0) AS estimated_remaining_usd
     FROM items WHERE run_id = ?`,
    [runId]
  );

  return {
    total: row?.total ?? 0,
    queued: row?.queued ?? 0,
    dispatching: row?.dispatching ?? 0,
    done: row?.done ?? 0,
    failed: row?.failed ?? 0,
    flagged: row?.flagged ?? 0,
    spendUsd: row?.spend_usd ?? 0,
    estimatedRemainingUsd: row?.estimated_remaining_usd ?? 0
  };
}

/**
 * Reads the most recently updated items of a run on an arbitrary driver
 * connection, for `readSnapshot`.
 *
 * @param driver - Any open SqliteDriver (primary or short-lived).
 * @param runId - Run id to read.
 * @param limit - Maximum number of rows to return.
 * @returns The most recently updated items, newest first.
 * @example
 * ```ts
 * const recent = readRecentItems(driver, runId, 20);
 * ```
 */
function readRecentItems(driver: SqliteDriver, runId: string, limit: number): ItemRow[] {
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
 * @example
 * ```ts
 * const { sql, params } = buildListItemsQuery(runId, { status: "queued" });
 * ```
 */
function buildListItemsQuery(
  runId: string,
  filter?: ItemFilter
): { sql: string; params: unknown[] } {
  const params: unknown[] = [runId];
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
 * @example
 * ```ts
 * const row = insertOneItem(driver, runId, intent, Date.now());
 * ```
 */
function insertOneItem(
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
       (id, run_id, build_file, planning_key, task, provider, pack_version, status, estimated_cost_usd, attempt_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?)`,
    [
      id,
      runId,
      item.buildFile,
      item.planningKey,
      item.task,
      item.provider,
      item.packVersion,
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
    artifactKey: SQL_NULL,
    contentHash: SQL_NULL,
    actualCostUsd: SQL_NULL,
    attemptCount: 0,
    updatedAt: now
  };
}

/**
 * Evaluates the gate's budget check for one item against its run's cap.
 *
 * @param driver - Open SqliteDriver, already inside a write transaction.
 * @param item - The candidate item's raw row.
 * @param maxCostUsd - The run's budget cap, or null when uncapped.
 * @returns True when admitting this item would stay within the cap.
 * @example
 * ```ts
 * const withinBudget = isWithinBudget(driver, item, run.max_cost_usd);
 * ```
 */
function isWithinBudget(
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
 * Creates the single `runs` row for one invocation.
 *
 * @param state - Journal plugin state.
 * @param opts - The invocation's file glob and optional budget cap.
 * @param opts.glob - The invocation's file pattern.
 * @param opts.maxCostUsd - Optional budget cap; omit for no cap.
 * @returns The newly created run row (status `active`).
 * @example
 * ```ts
 * const run = openRun(state, { glob: "voice/*.yaml" });
 * ```
 */
function openRun(state: State, opts: { glob: string; maxCostUsd?: number }): RunRow {
  const driver = requireDriver(state);
  return driver.transactionImmediate<RunRow>(() => {
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const maxCostUsd = opts.maxCostUsd ?? SQL_NULL;
    driver.run(
      "INSERT INTO runs (id, created_at, status, glob, max_cost_usd, finished_at) VALUES (?, ?, 'active', ?, ?, ?)",
      [id, createdAt, opts.glob, maxCostUsd, SQL_NULL]
    );
    return {
      id,
      createdAt,
      status: "active",
      glob: opts.glob,
      maxCostUsd,
      finishedAt: SQL_NULL
    };
  });
}

/**
 * Looks up one run by id.
 *
 * @param state - Journal plugin state.
 * @param runId - Run id to look up.
 * @returns The run row, or undefined if not found.
 * @example
 * ```ts
 * const run = getRun(state, runId);
 * ```
 */
function getRun(state: State, runId: string): RunRow | undefined {
  const driver = requireDriver(state);
  return readRun(driver, runId);
}

/**
 * Finds the most recently created run still eligible for `resume`
 * (status `active`, `paused`, or `budget-stopped`).
 *
 * @param state - Journal plugin state.
 * @returns The latest resumable run, or undefined if none exists.
 * @example
 * ```ts
 * const resumable = latestResumableRun(state);
 * ```
 */
function latestResumableRun(state: State): RunRow | undefined {
  const driver = requireDriver(state);
  const row = driver.get<RunDatabaseRow>(
    "SELECT * FROM runs WHERE status IN ('active', 'paused', 'budget-stopped') ORDER BY created_at DESC LIMIT 1"
  );
  return row ? mapRun(row) : undefined;
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
 * @example
 * ```ts
 * const rows = insertItems(state, runId, [intent]);
 * ```
 */
function insertItems(state: State, runId: string, items: ItemIntent[]): ItemRow[] {
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
 * @example
 * ```ts
 * const count = requeueDispatching(state, runId);
 * ```
 */
function requeueDispatching(state: State, runId: string): number {
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
 * @example
 * ```ts
 * const result = gateToDispatching(state, itemId);
 * ```
 */
function gateToDispatching(state: State, itemId: string): GateResult {
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

/**
 * Records the start of a provider attempt against an item.
 *
 * @param state - Journal plugin state.
 * @param itemId - Item id the attempt belongs to.
 * @param attempt - Provider, account, and start time.
 * @returns The new attempt's id.
 * @example
 * ```ts
 * const attemptId = recordAttempt(state, itemId, { provider: "elevenlabs", account: "default", startedAt: Date.now() });
 * ```
 */
function recordAttempt(state: State, itemId: string, attempt: AttemptStart): number {
  const driver = requireDriver(state);
  return driver.transactionImmediate<number>(() => {
    driver.run(
      "INSERT INTO attempts (item_id, provider, account, started_at) VALUES (?, ?, ?, ?)",
      [itemId, attempt.provider, attempt.account, attempt.startedAt]
    );
    const row = driver.get<{ id: number }>("SELECT last_insert_rowid() AS id");
    return row?.id ?? 0;
  });
}

/**
 * Records the end of a provider attempt.
 *
 * @param state - Journal plugin state.
 * @param attemptId - Attempt id, from `recordAttempt`.
 * @param end - End time, outcome, and optional error class / cost.
 * @example
 * ```ts
 * finishAttempt(state, attemptId, { endedAt: Date.now(), outcome: "done" });
 * ```
 */
function finishAttempt(state: State, attemptId: number, end: AttemptEnd): void {
  const driver = requireDriver(state);
  driver.transactionImmediate<void>(() => {
    driver.run(
      "UPDATE attempts SET ended_at = ?, outcome = ?, error_class = ?, cost_usd = ? WHERE id = ?",
      [end.endedAt, end.outcome, end.errorClass ?? SQL_NULL, end.costUsd ?? SQL_NULL, attemptId]
    );
  });
}

/**
 * Transitions an item `dispatching → done`, recording its actual cost and
 * artifact identity.
 *
 * @param state - Journal plugin state.
 * @param itemId - Item id to complete.
 * @param result - Actual cost, artifact key, and content hash.
 * @param result.actualCostUsd - The item's actual, realized cost.
 * @param result.artifactKey - Artifact identity key (planning key + provider + pack version).
 * @param result.contentHash - CAS content hash of the produced artifact.
 * @example
 * ```ts
 * commitDone(state, itemId, { actualCostUsd: 0.2, artifactKey, contentHash });
 * ```
 */
function commitDone(
  state: State,
  itemId: string,
  result: { actualCostUsd: number; artifactKey: string; contentHash: string }
): void {
  const driver = requireDriver(state);
  driver.transactionImmediate<void>(() => {
    driver.run(
      "UPDATE items SET status = 'done', actual_cost_usd = ?, artifact_key = ?, content_hash = ?, updated_at = ? WHERE id = ? AND status = 'dispatching'",
      [result.actualCostUsd, result.artifactKey, result.contentHash, Date.now(), itemId]
    );
  });
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
 * @example
 * ```ts
 * markFailed(state, itemId, { errorClass: "http-5xx", terminal: false });
 * ```
 */
function markFailed(
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
 * @example
 * ```ts
 * markFlagged(state, itemId);
 * ```
 */
function markFlagged(state: State, itemId: string): void {
  const driver = requireDriver(state);
  driver.transactionImmediate<void>(() => {
    driver.run(
      "UPDATE items SET status = 'flagged', updated_at = ? WHERE id = ? AND status = 'dispatching'",
      [Date.now(), itemId]
    );
  });
}

/**
 * Sets a run's status, recording `finished_at` when the new status is
 * terminal (`done` or `failed`).
 *
 * @param state - Journal plugin state.
 * @param runId - Run id to update.
 * @param status - The new run status.
 * @example
 * ```ts
 * setRunStatus(state, runId, "done");
 * ```
 */
function setRunStatus(state: State, runId: string, status: RunStatus): void {
  const driver = requireDriver(state);
  driver.transactionImmediate<void>(() => {
    const isFinal = status === "done" || status === "failed";
    driver.run(
      "UPDATE runs SET status = ?, finished_at = CASE WHEN ? THEN ? ELSE finished_at END WHERE id = ?",
      [status, isFinal ? 1 : 0, Date.now(), runId]
    );
  });
}

/**
 * Computes aggregate item counts and spend for a run.
 *
 * @param state - Journal plugin state.
 * @param runId - Run id to aggregate.
 * @returns Aggregate counts and spend for the run.
 * @example
 * ```ts
 * const totals = totalsOf(state, runId);
 * ```
 */
function totalsOf(state: State, runId: string): RunTotals {
  const driver = requireDriver(state);
  return readTotals(driver, runId);
}

/**
 * Lists a run's items, optionally filtered by status, capped by limit, or
 * paged by `afterUpdatedAt`.
 *
 * @param state - Journal plugin state.
 * @param runId - Run id to list.
 * @param filter - Optional status/limit/afterUpdatedAt filter.
 * @returns The matching items, oldest-updated first.
 * @example
 * ```ts
 * const queued = listItemsOf(state, runId, { status: "queued" });
 * ```
 */
function listItemsOf(state: State, runId: string, filter?: ItemFilter): ItemRow[] {
  const driver = requireDriver(state);
  const { sql, params } = buildListItemsQuery(runId, filter);
  return driver.all<ItemDatabaseRow>(sql, params).map(row => mapItem(row));
}

/**
 * Reads a point-in-time snapshot of a run (run row, totals, most recent
 * items) on its own short-lived connection — opens, reads, closes. Intended
 * for a second process (`moku status --follow`) reading a shared file.
 *
 * @param state - Journal plugin state (only used to enforce the not-open guard).
 * @param config - Resolved journal configuration (db path + busy timeout).
 * @param runId - Run id to read.
 * @returns The run's snapshot.
 * @throws {Error} When the run cannot be found.
 * @example
 * ```ts
 * const snapshot = readRunSnapshot(state, config, runId);
 * ```
 */
function readRunSnapshot(state: State, config: Config, runId: string): RunSnapshot {
  requireDriver(state);
  const readOnlyDriver = openSqliteDriver({
    path: config.path,
    busyTimeoutMs: config.busyTimeoutMs
  });
  try {
    const run = readRun(readOnlyDriver, runId);
    if (!run) {
      throw new Error(
        `[ai] Run not found: ${runId}.\n  Verify the run id came from openRun() for this invocation.`
      );
    }
    return {
      run,
      totals: readTotals(readOnlyDriver, runId),
      recentItems: readRecentItems(readOnlyDriver, runId, RECENT_ITEMS_LIMIT)
    };
  } finally {
    readOnlyDriver.close();
  }
}

/**
 * Runs a manual `wal_checkpoint(TRUNCATE)` on the primary connection.
 *
 * @param state - Journal plugin state.
 * @example
 * ```ts
 * checkpointNow(state);
 * ```
 */
function checkpointNow(state: State): void {
  const driver = requireDriver(state);
  driver.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

/**
 * Creates the journal API surface (ctx.journal.*).
 *
 * @param ctx - Core plugin context (config + state).
 * @returns The journal's public API, injected as `ctx.journal` on every
 *   regular plugin's context.
 * @example
 * ```ts
 * const api = createJournalApi({ config, state });
 * ```
 */
export function createJournalApi(ctx: CorePluginContext<Config, State>): JournalApi {
  const { config, state } = ctx;

  /**
   * Creates the single `runs` row for one invocation, bound to this API's state.
   *
   * @param opts - The invocation's file glob and optional budget cap.
   * @param opts.glob - The invocation's file pattern.
   * @param opts.maxCostUsd - Optional budget cap; omit for no cap.
   * @returns The newly created run row (status `active`).
   * @example
   * ```ts
   * const run = api.openRun({ glob: "voice/*.yaml" });
   * ```
   */
  const boundOpenRun = (opts: { glob: string; maxCostUsd?: number }): RunRow =>
    openRun(state, opts);

  /**
   * Looks up one run by id, bound to this API's state.
   *
   * @param runId - Run id to look up.
   * @returns The run row, or undefined if not found.
   * @example
   * ```ts
   * const run = api.getRun(runId);
   * ```
   */
  const boundGetRun = (runId: string): RunRow | undefined => getRun(state, runId);

  /**
   * Finds the latest resumable run, bound to this API's state.
   *
   * @returns The latest resumable run, or undefined if none exists.
   * @example
   * ```ts
   * const resumable = api.latestResumableRun();
   * ```
   */
  const boundLatestResumableRun = (): RunRow | undefined => latestResumableRun(state);

  /**
   * Inserts planning-time item intents, bound to this API's state.
   *
   * @param runId - Run id the items belong to.
   * @param items - Planning-time item intents.
   * @returns The existing or newly inserted item rows, in input order.
   * @example
   * ```ts
   * const rows = api.insertItems(runId, [intent]);
   * ```
   */
  const boundInsertItems = (runId: string, items: ItemIntent[]): ItemRow[] =>
    insertItems(state, runId, items);

  /**
   * Requeues every dispatching item of a run, bound to this API's state.
   *
   * @param runId - Run id to requeue.
   * @returns The number of items requeued.
   * @example
   * ```ts
   * const count = api.requeueDispatching(runId);
   * ```
   */
  const boundRequeueDispatching = (runId: string): number => requeueDispatching(state, runId);

  /**
   * The atomic budget + dedup gate, bound to this API's state.
   *
   * @param itemId - Item id to admit.
   * @returns `{ ok: true }` on admission, or `{ ok: false, reason }` when blocked.
   * @example
   * ```ts
   * const result = api.gateToDispatching(itemId);
   * ```
   */
  const boundGateToDispatching = (itemId: string): GateResult => gateToDispatching(state, itemId);

  /**
   * Records the start of a provider attempt, bound to this API's state.
   *
   * @param itemId - Item id the attempt belongs to.
   * @param attempt - Provider, account, and start time.
   * @returns The new attempt's id.
   * @example
   * ```ts
   * const attemptId = api.recordAttempt(itemId, { provider: "elevenlabs", account: "default", startedAt: Date.now() });
   * ```
   */
  const boundRecordAttempt = (itemId: string, attempt: AttemptStart): number =>
    recordAttempt(state, itemId, attempt);

  /**
   * Records the end of a provider attempt, bound to this API's state.
   *
   * @param attemptId - Attempt id, from `recordAttempt`.
   * @param end - End time, outcome, and optional error class / cost.
   * @example
   * ```ts
   * api.finishAttempt(attemptId, { endedAt: Date.now(), outcome: "done" });
   * ```
   */
  const boundFinishAttempt = (attemptId: number, end: AttemptEnd): void => {
    finishAttempt(state, attemptId, end);
  };

  /**
   * Transitions an item to done, bound to this API's state.
   *
   * @param itemId - Item id to complete.
   * @param result - Actual cost, artifact key, and content hash.
   * @param result.actualCostUsd - The item's actual, realized cost.
   * @param result.artifactKey - Artifact identity key (planning key + provider + pack version).
   * @param result.contentHash - CAS content hash of the produced artifact.
   * @example
   * ```ts
   * api.commitDone(itemId, { actualCostUsd: 0.2, artifactKey, contentHash });
   * ```
   */
  const boundCommitDone = (
    itemId: string,
    result: { actualCostUsd: number; artifactKey: string; contentHash: string }
  ): void => {
    commitDone(state, itemId, result);
  };

  /**
   * Transitions an item to failed or back to queued, bound to this API's state.
   *
   * @param itemId - Item id that failed.
   * @param result - The error class and whether it is terminal.
   * @param result.errorClass - Classification of the failure.
   * @param result.terminal - True for a terminal failure; false to retry (re-queue).
   * @example
   * ```ts
   * api.markFailed(itemId, { errorClass: "http-5xx", terminal: false });
   * ```
   */
  const boundMarkFailed = (
    itemId: string,
    result: { errorClass: ErrorClass; terminal: boolean }
  ): void => {
    markFailed(state, itemId, result);
  };

  /**
   * Transitions an item to flagged, bound to this API's state.
   *
   * @param itemId - Item id to flag.
   * @example
   * ```ts
   * api.markFlagged(itemId);
   * ```
   */
  const boundMarkFlagged = (itemId: string): void => {
    markFlagged(state, itemId);
  };

  /**
   * Sets a run's status, bound to this API's state.
   *
   * @param runId - Run id to update.
   * @param status - The new run status.
   * @example
   * ```ts
   * api.setRunStatus(runId, "done");
   * ```
   */
  const boundSetRunStatus = (runId: string, status: RunStatus): void => {
    setRunStatus(state, runId, status);
  };

  /**
   * Computes aggregate item counts and spend, bound to this API's state.
   *
   * @param runId - Run id to aggregate.
   * @returns Aggregate counts and spend for the run.
   * @example
   * ```ts
   * const totals = api.totals(runId);
   * ```
   */
  const boundTotals = (runId: string): RunTotals => totalsOf(state, runId);

  /**
   * Lists a run's items, bound to this API's state.
   *
   * @param runId - Run id to list.
   * @param filter - Optional status/limit/afterUpdatedAt filter.
   * @returns The matching items, oldest-updated first.
   * @example
   * ```ts
   * const queued = api.listItems(runId, { status: "queued" });
   * ```
   */
  const boundListItems = (runId: string, filter?: ItemFilter): ItemRow[] =>
    listItemsOf(state, runId, filter);

  /**
   * Reads a point-in-time run snapshot on its own short-lived connection,
   * bound to this API's state and config.
   *
   * @param runId - Run id to read.
   * @returns The run's snapshot.
   * @example
   * ```ts
   * const snapshot = api.readSnapshot(runId);
   * ```
   */
  const boundReadSnapshot = (runId: string): RunSnapshot => readRunSnapshot(state, config, runId);

  /**
   * Runs a manual checkpoint, bound to this API's state.
   *
   * @example
   * ```ts
   * api.checkpoint();
   * ```
   */
  const boundCheckpoint = (): void => {
    checkpointNow(state);
  };

  return {
    openRun: boundOpenRun,
    getRun: boundGetRun,
    latestResumableRun: boundLatestResumableRun,
    insertItems: boundInsertItems,
    requeueDispatching: boundRequeueDispatching,
    gateToDispatching: boundGateToDispatching,
    recordAttempt: boundRecordAttempt,
    finishAttempt: boundFinishAttempt,
    commitDone: boundCommitDone,
    markFailed: boundMarkFailed,
    markFlagged: boundMarkFlagged,
    setRunStatus: boundSetRunStatus,
    totals: boundTotals,
    listItems: boundListItems,
    readSnapshot: boundReadSnapshot,
    checkpoint: boundCheckpoint
  };
}
