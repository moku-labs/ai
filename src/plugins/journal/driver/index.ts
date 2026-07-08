/**
 * @file journal driver lifecycle — open (dir + driver + pragmas + schema +
 * checkpoint timer) and close (timer + final checkpoint + connection) for
 * the plugin's onStart/onStop.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { CorePluginContext } from "@moku-labs/core";
import { createSchema } from "../schema";
import type { Config, State } from "../types";
import { openSqliteDriver } from "./select";

/**
 * Opens the journal for one app lifecycle: ensures the parent directory
 * exists, opens the runtime-appropriate driver with the durability pragma
 * set applied, creates the schema idempotently, and starts the writer-side
 * checkpoint timer (unref'd so it never holds the process open).
 *
 * @param ctx - Core plugin lifecycle context (config + state).
 * @example
 * ```ts
 * await openDriver({ config, state });
 * ```
 */
export function openDriver(ctx: CorePluginContext<Config, State>): void {
  mkdirSync(path.dirname(ctx.config.path), { recursive: true });

  const driver = openSqliteDriver({
    path: ctx.config.path,
    busyTimeoutMs: ctx.config.busyTimeoutMs
  });
  createSchema(driver);

  ctx.state.driver = driver;
  ctx.state.checkpointTimer = setInterval(() => {
    driver.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }, ctx.config.checkpointIntervalMs);
  ctx.state.checkpointTimer.unref();
}

/**
 * Closes the journal for one app lifecycle: stops the checkpoint timer, runs
 * a final wal_checkpoint(TRUNCATE), and closes the connection.
 *
 * @param ctx - Core plugin lifecycle context (config + state).
 * @example
 * ```ts
 * await closeDriver({ config, state });
 * ```
 */
export function closeDriver(ctx: CorePluginContext<Config, State>): void {
  if (ctx.state.checkpointTimer) {
    clearInterval(ctx.state.checkpointTimer);
    // eslint-disable-next-line unicorn/no-null -- spec/01 pins null as the "not running" sentinel (State fields are `X | null`)
    ctx.state.checkpointTimer = null;
  }

  if (ctx.state.driver) {
    ctx.state.driver.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    ctx.state.driver.close();
    // eslint-disable-next-line unicorn/no-null -- spec/01 pins null as the "not opened" sentinel (State fields are `X | null`)
    ctx.state.driver = null;
  }
}
