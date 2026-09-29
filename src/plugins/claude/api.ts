/**
 * @file claude provider plugin — API factory (`app.claude.info()`).
 */
import { isBinResolvable } from "./cli";
import type { ClaudeApi, ClaudeContext } from "./types";

/**
 * Creates the claude API surface (`info()`). PATH is read through
 * `ctx.env` (MC3), never from the raw process environment.
 *
 * @param ctx - Plugin context (config, env).
 * @returns The `app.claude` API.
 */
export function createClaudeApi(ctx: ClaudeContext): ClaudeApi {
  return {
    info: () => ({
      provider: "claude",
      configured: isBinResolvable(ctx.config.bin, ctx.env.get("PATH"))
    })
  };
}
