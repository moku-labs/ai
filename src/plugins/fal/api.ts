/**
 * @file fal provider plugin — API factory (`app.fal.info()`).
 */
import { falAliases } from "./models";
import type { FalApi, FalContext, FalInfo } from "./types";

/**
 * Creates the fal API surface (`info()`).
 *
 * @param ctx - Plugin context (config, env).
 * @returns The `app.fal` API.
 * @example
 * ```ts
 * const api = createFalApi(ctx);
 * api.info(); // => { provider: "fal", configured: true, models: ["seedance-2.5", ...] }
 * ```
 */
export function createFalApi(ctx: FalContext): FalApi {
  return {
    /**
     * Provider health/info for `moku status` + docs. Never throws.
     *
     * @returns Whether the key env var is present, and the accepted model aliases.
     * @example
     * ```ts
     * app.fal.info();
     * ```
     */
    info(): FalInfo {
      return {
        provider: "fal",
        configured: ctx.env.has(ctx.config.apiKeyEnv),
        models: falAliases()
      };
    }
  };
}
