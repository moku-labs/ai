/**
 * @file openai provider plugin — API factory (`app.openai.info()`).
 */
import type { OpenaiApi, OpenaiContext } from "./types";

/**
 * Creates the openai API surface (`info`). Reads the configured API key via
 * `ctx.env.get` — never throws, and never constructs the SDK client (that
 * stays lazy until the first `execute()` call).
 *
 * @param ctx - Plugin context (config + env).
 * @returns The `app.openai` API.
 * @example
 * ```ts
 * const api = createOpenaiApi(ctx);
 * api.info(); // => { provider: "openai", configured: true, models: {...} }
 * ```
 */
export function createOpenaiApi(ctx: OpenaiContext): OpenaiApi {
  return {
    /**
     * Provider health/info: whether an API key is configured, without ever
     * throwing, plus the default models per capability.
     *
     * @returns The provider info snapshot.
     * @example
     * ```ts
     * app.openai.info(); // => { provider: "openai", configured: true, models: {...} }
     * ```
     */
    info(): { provider: "openai"; configured: boolean; models: { tts: string; chat: string } } {
      return {
        provider: "openai",
        configured: ctx.env.get(ctx.config.apiKeyEnv) !== undefined,
        models: { tts: ctx.config.models.tts, chat: ctx.config.models.chat }
      };
    }
  };
}
