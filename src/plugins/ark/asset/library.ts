/**
 * @file Ark asset library listing, field mapping and deletion cache cleanup.
 */
import type { OpenApiBodies } from "../client";
import { openApiCall, readString } from "../client";
import type { ArkAsset, ArkAssetGroup, ArkContext } from "../types";
import { walkAssetPages } from "./pages";

/**
 * Checks an asset or group id before any provider call.
 *
 * @param id - The requested id.
 * @param field - The public field name.
 * @throws {Error} A plain two-line error when the id is empty.
 */
function checkId(id: string, field: "assetId" | "groupId"): void {
  if (id !== "") return;
  throw new Error(`[ai] ark asset ${field} must not be empty.\n  Pass a valid ${field}.`);
}

/**
 * Maps a group with a string id, preserving an optional creation time.
 *
 * @param item - Untrusted Ark group.
 * @returns The public group, or undefined when its id is unusable.
 */
function readAssetGroup(item: unknown): ArkAssetGroup | undefined {
  const groupId = readString(item, "Id");
  if (groupId === undefined) return undefined;

  const createTime = readString(item, "CreateTime");
  return {
    groupId,
    name: readString(item, "Name") ?? "",
    ...(createTime === undefined ? {} : { createTime })
  };
}

/**
 * Maps an asset with a string id, preserving its optional time strings.
 *
 * @param item - Untrusted Ark asset.
 * @returns The public asset, or undefined when its id is unusable.
 */
function readAsset(item: unknown): ArkAsset | undefined {
  const assetId = readString(item, "Id");
  if (assetId === undefined) return undefined;

  const createTime = readString(item, "CreateTime");
  const updateTime = readString(item, "UpdateTime");
  const lastInferenceTime = readString(item, "LastInferenceTime");
  return {
    assetId,
    name: readString(item, "Name") ?? "",
    groupId: readString(item, "GroupId") ?? "",
    status: readString(item, "Status") ?? "unknown",
    ...(createTime === undefined ? {} : { createTime }),
    ...(updateTime === undefined ? {} : { updateTime }),
    ...(lastInferenceTime === undefined ? {} : { lastInferenceTime })
  };
}

/**
 * Lists every AIGC asset group through the signed OpenAPI.
 *
 * @param ctx - Plugin context (config, env).
 * @param signal - Caller abort signal.
 * @returns All groups with string ids, in Ark's page order.
 * @example
 * ```ts
 * const groups = await listAssetGroups(ctx, signal);
 * ```
 */
export async function listAssetGroups(
  ctx: ArkContext,
  signal: AbortSignal | undefined
): Promise<ArkAssetGroup[]> {
  const groups: ArkAssetGroup[] = [];
  await walkAssetPages(
    (pageNumber, pageSize) =>
      openApiCall(
        ctx,
        "ListAssetGroups",
        { Filter: { GroupType: "AIGC" }, PageNumber: pageNumber, PageSize: pageSize },
        signal
      ),
    items => {
      for (const item of items) {
        const group = readAssetGroup(item);
        if (group !== undefined) groups.push(group);
      }
    }
  );
  return groups;
}

/**
 * Lists every AIGC asset, optionally restricted to one group.
 *
 * @param ctx - Plugin context (config, env).
 * @param groupId - Optional group filter.
 * @param signal - Caller abort signal.
 * @returns All assets with string ids, in Ark's page order.
 * @example
 * ```ts
 * const assets = await listAssets(ctx, "group-1", signal);
 * ```
 */
export async function listAssets(
  ctx: ArkContext,
  groupId: string | undefined,
  signal: AbortSignal | undefined
): Promise<ArkAsset[]> {
  if (groupId !== undefined) checkId(groupId, "groupId");

  const filter: OpenApiBodies["ListAssets"]["Filter"] = {
    GroupType: "AIGC",
    ...(groupId === undefined ? {} : { GroupIds: [groupId] })
  };
  const assets: ArkAsset[] = [];
  await walkAssetPages(
    (pageNumber, pageSize) =>
      openApiCall(
        ctx,
        "ListAssets",
        { Filter: filter, PageNumber: pageNumber, PageSize: pageSize },
        signal
      ),
    items => {
      for (const item of items) {
        const asset = readAsset(item);
        if (asset !== undefined) assets.push(asset);
      }
    }
  );
  return assets;
}

/**
 * Deletes one asset and forgets its Active preflight entry after success.
 *
 * @param ctx - Plugin context (config, env, state).
 * @param assetId - The asset to delete.
 * @param signal - Caller abort signal.
 * @returns Resolves after deletion and cache cleanup.
 * @example
 * ```ts
 * await deleteAsset(ctx, "asset-1", signal);
 * ```
 */
export async function deleteAsset(
  ctx: ArkContext,
  assetId: string,
  signal: AbortSignal | undefined
): Promise<void> {
  checkId(assetId, "assetId");

  await openApiCall(ctx, "DeleteAsset", { Id: assetId }, signal);
  ctx.state.activeAssets.delete(assetId);
}

/**
 * Forgets cached names whose group promises resolve to the deleted id.
 *
 * @param ctx - Plugin context (state).
 * @param groupId - The deleted group id.
 * @returns Resolves after all cached group promises settle.
 */
async function forgetGroup(ctx: ArkContext, groupId: string): Promise<void> {
  const settled = await Promise.allSettled(
    [...ctx.state.group].map(async ([name, pending]) => ({ name, id: await pending }))
  );
  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") continue;
    if (outcome.value.id === groupId) ctx.state.group.delete(outcome.value.name);
  }
}

/**
 * Deletes a group and its assets, then forgets matching names and Active assets.
 *
 * @param ctx - Plugin context (config, env, state).
 * @param groupId - The group to delete.
 * @param signal - Caller abort signal.
 * @returns Resolves after deletion and cache cleanup.
 * @example
 * ```ts
 * await deleteAssetGroup(ctx, "group-1", signal);
 * ```
 */
export async function deleteAssetGroup(
  ctx: ArkContext,
  groupId: string,
  signal: AbortSignal | undefined
): Promise<void> {
  checkId(groupId, "groupId");

  await openApiCall(ctx, "DeleteAssetGroup", { Id: groupId }, signal);
  await forgetGroup(ctx, groupId);
  ctx.state.activeAssets.clear();
}
