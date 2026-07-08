/**
 * @file store core plugin — API factory skeleton.
 */
import type { Config, State, StoreApi } from "./types";

/**
 * Creates the store API surface (ctx.store.*).
 *
 * @param _ctx - Core plugin context (config + state).
 * @param _ctx.config - Resolved store configuration.
 * @param _ctx.state - Store state (root-ensured flag).
 * @example
 * ```ts
 * const api = createStoreApi({ config, state });
 * ```
 */
export function createStoreApi(_ctx: {
  readonly config: Readonly<Config>;
  readonly state: State;
}): StoreApi {
  throw new Error("not implemented");
}
