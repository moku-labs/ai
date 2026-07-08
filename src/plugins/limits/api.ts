/**
 * @file limits core plugin — API factory skeleton.
 */
import type { Config, LimitsApi, State } from "./types";

/**
 * Creates the limits API surface (ctx.limits.*).
 *
 * @param _ctx - Core plugin context (config + state).
 * @param _ctx.config - Resolved limits configuration.
 * @param _ctx.state - Limits state (per-lane buckets).
 * @example
 * ```ts
 * const api = createLimitsApi({ config, state });
 * ```
 */
export function createLimitsApi(_ctx: {
  readonly config: Readonly<Config>;
  readonly state: State;
}): LimitsApi {
  throw new Error("not implemented");
}
