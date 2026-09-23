/**
 * @file codex provider plugin — API factory (`app.codex.info()`).
 */
import { isBinResolvable } from "./cli";
import { resolvePrices } from "./prices";
import type { CodexApi, CodexContext, CodexInfo } from "./types";

/**
 * Creates the codex API surface (`info()`).
 *
 * @param ctx - Plugin context (config, state, env).
 * @returns The `app.codex` API.
 * @example
 * ```ts
 * const api = createCodexApi(ctx);
 * api.info(); // => { provider: "codex", configured: true, models: ["gpt-6-astra"] }
 * ```
 */
export function createCodexApi(ctx: CodexContext): CodexApi {
  return {
    /**
     * Provider health/info for `moku status` and docs. PATH is read via
     * `ctx.env`, never `process.env`.
     *
     * @returns Whether the CLI is found, and the models with a known price.
     * @example
     * ```ts
     * app.codex.info();
     * ```
     */
    info(): CodexInfo {
      return {
        provider: "codex",
        configured: isBinResolvable(ctx.config.bin, ctx.env.get("PATH")),
        models: Object.keys(resolvePrices(ctx))
      };
    }
  };
}
