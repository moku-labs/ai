/**
 * @file apimodels provider plugin — API factory (`app.apimodels.info()`).
 */
import type { ApimodelsApi, ApimodelsContext, ApimodelsInfo } from "./types";
import { apimodelsAliases } from "./video/models";

/**
 * Creates the apimodels API surface (`info()`).
 *
 * @param ctx - Plugin context (config, env).
 * @returns The `app.apimodels` API.
 */
export function createApimodelsApi(ctx: ApimodelsContext): ApimodelsApi {
  return {
    info: (): ApimodelsInfo => ({
      provider: "apimodels",
      configured: ctx.env.has(ctx.config.apiKeyEnv),
      models: apimodelsAliases()
    })
  };
}
