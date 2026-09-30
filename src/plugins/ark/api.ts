/**
 * @file ark provider plugin — API factory (`app.ark.info()`).
 */
import { imageModelsOf } from "./image/models";
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
 * Creates the ark API surface (`info()`): no network call.
 *
 * @param ctx - Plugin context (config, env).
 * @returns The `app.ark` API.
 */
export function createArkApi(ctx: ArkContext): ArkApi {
  return {
    info: (): ArkInfo => {
      const hasApiKey = isSet(ctx, ctx.config.apiKeyEnv);
      return {
        provider: "ark",
        region: ctx.config.region,
        configured: {
          video: hasApiKey,
          assets: isSet(ctx, ctx.config.accessKeyEnv) && isSet(ctx, ctx.config.secretKeyEnv),
          image: hasApiKey
        },
        models: modelsOf(ctx.config.region),
        imageModels: imageModelsOf(ctx.config.region)
      };
    }
  };
}
