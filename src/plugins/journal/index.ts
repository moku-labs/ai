/**
 * Core plugin (Complex tier) — SQLite WAL journal: durable run/item/attempt
 * state machine, atomic budget+dedup gate, checkpoint scheduling. ctx.journal.
 *
 * @see README.md
 */
import { createCorePlugin } from "@moku-labs/core";
import { createJournalApi } from "./api";
import { closeDriver, openDriver } from "./driver";
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
  onStart: openDriver,
  onStop: closeDriver
});
