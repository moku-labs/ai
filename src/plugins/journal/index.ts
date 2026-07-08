/**
 * Core plugin (Complex tier) — SQLite WAL journal: durable run/item/attempt
 * state machine, atomic budget+dedup gate, checkpoint scheduling. ctx.journal.
 *
 * @see README.md
 */
import { createCorePlugin } from "@moku-labs/core";
import { createJournalApi } from "./api";
import { createJournalState } from "./state";
import type { Config } from "./types";

const defaultConfig: Config = {
  path: ".moku/journal.db",
  checkpointIntervalMs: 30_000,
  busyTimeoutMs: 5000
};

/**
 * journal — Core plugin (Complex tier). SQLite WAL journal; injected as ctx.journal.
 *
 * @see README.md
 */
// @no-resource-check — onStart opens the SQLite driver connection + checkpoint timer; onStop closes both (spec/01)
export const journalPlugin = createCorePlugin("journal", {
  config: defaultConfig,
  createState: createJournalState,
  api: createJournalApi,
  /**
   * Opens the driver, applies the durability pragma set
   * (WAL/FULL/fullfsync/busy_timeout), creates the schema, and starts the
   * checkpoint timer.
   *
   * @param _ctx - Core plugin lifecycle context.
   * @example
   * ```ts
   * await app.start();
   * ```
   */
  onStart: async _ctx => {
    throw new Error("not implemented");
  },
  /**
   * Stops the checkpoint timer, runs a final wal_checkpoint(TRUNCATE), and
   * closes the driver.
   *
   * @param _ctx - Core plugin lifecycle context.
   * @example
   * ```ts
   * await app.stop();
   * ```
   */
  onStop: async _ctx => {
    throw new Error("not implemented");
  }
});
