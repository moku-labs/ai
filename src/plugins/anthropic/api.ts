/**
 * @file anthropic provider plugin — API factory (`app.anthropic.info()`).
 */
import type { AnthropicApi, AnthropicContext } from "./types";

/**
 * Creates the anthropic API. `info` reads the key through `ctx.env.get`:
 * it never throws and never builds the SDK client.
 *
 * @param ctx - Plugin context (config + env).
 * @returns The `app.anthropic` API.
 */
export function createAnthropicApi(ctx: AnthropicContext): AnthropicApi {
  return {
    info: () => ({
      provider: "anthropic",
      configured: ctx.env.get(ctx.config.apiKeyEnv) !== undefined,
      model: ctx.config.model
    })
  };
}
