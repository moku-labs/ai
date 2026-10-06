/**
 * @file ark provider plugin — API factory (`app.ark.info()`).
 */
import { deleteAsset, deleteAssetGroup, listAssetGroups, listAssets } from "./asset/library";
import { imageModelsOf } from "./image/models";
import { modelsOf } from "./models";
import type { ArkApi, ArkAsset, ArkAssetGroup, ArkContext, ArkInfo } from "./types";

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
 * Creates the ark information and asset library API surface.
 *
 * @param ctx - Plugin context (config, env).
 * @returns The `app.ark` API.
 * @example
 * ```ts
 * const groups = await createArkApi(ctx).listAssetGroups();
 * ```
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
    },
    listAssetGroups: (opts?: { signal?: AbortSignal }): Promise<ArkAssetGroup[]> =>
      listAssetGroups(ctx, opts?.signal),
    listAssets: (
      filter?: { groupId?: string },
      opts?: { signal?: AbortSignal }
    ): Promise<ArkAsset[]> => listAssets(ctx, filter?.groupId, opts?.signal),
    deleteAsset: (assetId: string, opts?: { signal?: AbortSignal }): Promise<void> =>
      deleteAsset(ctx, assetId, opts?.signal),
    deleteAssetGroup: (groupId: string, opts?: { signal?: AbortSignal }): Promise<void> =>
      deleteAssetGroup(ctx, groupId, opts?.signal)
  };
}
