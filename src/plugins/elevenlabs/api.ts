/**
 * @file elevenlabs provider plugin — API factory (`app.elevenlabs.info()`).
 */
import { resolvePrices } from "./prices";
import type { ElevenlabsApi, ElevenlabsContext } from "./types";

/**
 * Creates the elevenlabs API surface (`info()`).
 *
 * @param ctx - Plugin context (config, state, env).
 * @returns The `app.elevenlabs` API.
 * @example
 * ```ts
 * const api = createElevenlabsApi(ctx);
 * api.info(); // => { provider: "elevenlabs", configured: true, models: [...] }
 * ```
 */
export function createElevenlabsApi(ctx: ElevenlabsContext): ElevenlabsApi {
  return {
    /**
     * Provider health/info for `moku status` + docs.
     *
     * @returns Whether the provider is configured (an API key is present, without throwing) and the models known to the effective price table.
     * @example
     * ```ts
     * app.elevenlabs.info();
     * ```
     */
    info(): { provider: "elevenlabs"; configured: boolean; models: string[] } {
      const prices = resolvePrices(ctx);
      return {
        provider: "elevenlabs",
        configured: ctx.env.has(ctx.config.apiKeyEnv),
        models: Object.keys(prices)
      };
    }
  };
}
