/**
 * @file ark provider plugin — API factory (`app.ark.info()`).
 */
import { modelsOf } from "./models";
import type { ArkApi, ArkContext, ArkInfo } from "./types";

/**
 * Whether an env var holds a non-empty value. Reads through `ctx.env.get`,
 * so it never throws.
 *
 * @param ctx - Plugin context (env).
 * @param name - The env var name.
 * @returns True when set and not empty.
 */
function isSet(ctx: ArkContext, name: string): boolean {
  const value = ctx.env.get(name);
  return value !== undefined && value !== "";
}

/**
 * Creates the ark API surface (`info()`).
 *
 * @param ctx - Plugin context (config, env).
 * @returns The `app.ark` API.
 */
export function createArkApi(ctx: ArkContext): ArkApi {
  return {
    info: (): ArkInfo => ({
      provider: "ark",
      region: ctx.config.region,
      configured: {
        video: isSet(ctx, ctx.config.apiKeyEnv),
        assets: isSet(ctx, ctx.config.accessKeyEnv) && isSet(ctx, ctx.config.secretKeyEnv)
      },
      models: modelsOf(ctx.config.region)
    })
  };
}
