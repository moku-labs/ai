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
 */
export function createFalApi(ctx: FalContext): FalApi {
  return {
    info: (): FalInfo => ({
      provider: "fal",
      configured: ctx.env.has(ctx.config.apiKeyEnv),
      models: falAliases()
    })
  };
}
