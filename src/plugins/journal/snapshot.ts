/**
 * @file journal core plugin — work outside the write path: the point-in-time run snapshot on a
 * short-lived connection, and the manual WAL checkpoint.
 */
import { requireDriver } from "./db";
import { openSqliteDriver } from "./driver/select";
import { readRecentItems } from "./items";
import { readRun, readTotals } from "./runs";
import type { Config, RunSnapshot, State } from "./types";

/** How many most-recent items `readRunSnapshot` returns as `recentItems`. */
export const RECENT_ITEMS_LIMIT = 20;

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
 */
export function readRunSnapshot(state: State, config: Config, runId: string): RunSnapshot {
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
 */
export function checkpointNow(state: State): void {
  const driver = requireDriver(state);
  driver.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}
