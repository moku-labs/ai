/**
 * @file journal core plugin — API factory skeleton.
 */
import type { Config, JournalApi, State } from "./types";

/**
 * Creates the journal API surface (ctx.journal.*).
 *
 * @param _ctx - Core plugin context (config + state).
 * @param _ctx.config - Resolved journal configuration.
 * @param _ctx.state - Journal state (driver + checkpoint timer).
 * @example
 * ```ts
 * const api = createJournalApi({ config, state });
 * ```
 */
export function createJournalApi(_ctx: {
  readonly config: Readonly<Config>;
  readonly state: State;
}): JournalApi {
  throw new Error("not implemented");
}
