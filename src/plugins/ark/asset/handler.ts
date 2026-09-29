/**
 * @file ark asset handler — implements the task-owned asset contract
 * (`../../asset/contract.ts`) over the signed Ark asset OpenAPI. `submit`
 * checks the request and the image locally, finds or creates the AIGC group
 * and calls `CreateAsset` (ark fetches the portrait from its public URL);
 * `poll` reads the asset once with `GetAsset`. A refused registration is
 * `failed` with a flagged error: nothing falls back to sending the raw photo,
 * and nothing retries a refusal.
 */
import path from "node:path";
import type { AssetHandler, AssetJobPoll, AssetRequest } from "../../asset/contract";
import { ASSET_MIME, encodeAssetRecord } from "../../asset/contract";
import { ownAccount } from "../account";
import { openApiCall, readString, shorten, unreadableResponse } from "../client";
import { FlaggedProviderError } from "../errors";
import { checkAssetImage, readAssetImage } from "../image-check";
import type { ArkContext } from "../types";
import { findOrCreateGroup } from "./group";

/**
 * What `GetAsset` says about one asset.
 *
 * @example
 * ```ts
 * const asset: ArkAssetStatus = { status: "Failed", failedReason: "No human face detected in the image" };
 * ```
 */
export type ArkAssetStatus = {
  /** `Processing`, `Active`, `Failed`, or another value ark adds later. */
  status: string | undefined;
  /** Why ark refused the asset, when it did. */
  failedReason: string | undefined;
};

/** Longest display name ark takes. */
const MAX_NAME_LENGTH = 64;

/** The one pending poll value. */
const PENDING: AssetJobPoll = { state: "pending" };

/** The only group kind of v1. */
const AIGC_GROUP = "aigc";

/**
 * The display name sent to ark: `request.name`, else the image's base name,
 * cut to 64 characters.
 *
 * @param request - The registration request.
 * @returns The name.
 * @example
 * ```ts
 * assetNameOf({ image: { path: "faces/mira.png", mimeType: "image/png", hash: "h" } }); // => "mira.png"
 * ```
 */
function assetNameOf(request: AssetRequest): string {
  return (request.name ?? path.basename(request.image.path)).slice(0, MAX_NAME_LENGTH);
}

/**
 * Refuses a group kind other than `"aigc"` (the only one in v1).
 *
 * @param group - `request.group`, as given in the build file.
 * @throws {Error} A plain two-line error for another group kind.
 * @example
 * ```ts
 * checkGroup("liveness"); // throws: '[ai] ark asset group "liveness" is not supported.\n  Use group "aigc" or leave it out.'
 * ```
 */
function checkGroup(group: string | undefined): void {
  if (group === undefined || group === AIGC_GROUP) return;
  throw new Error(
    `[ai] ark asset group "${group}" is not supported.\n  Use group "aigc" or leave it out.`
  );
}

/**
 * Checks the public https URL ark fetches the portrait from.
 *
 * @param url - `request.url`.
 * @returns The URL.
 * @throws {Error} A plain two-line error when it is missing or not https.
 * @example
 * ```ts
 * checkUrl("https://cdn.example/faces/mira.png"); // => "https://cdn.example/faces/mira.png"
 * ```
 */
function checkUrl(url: string | undefined): string {
  if (url === undefined || !URL.canParse(url) || new URL(url).protocol !== "https:") {
    throw new Error(
      "[ai] ark CreateAsset needs a public https url.\n  Pass input.url with the same bytes as input.image."
    );
  }
  return url;
}

/**
 * Splits the job id `submit` returned.
 *
 * @param jobId - `"<groupId>/<assetId>"`.
 * @returns The group id and the asset id.
 * @throws {Error} A plain two-line error for another shape.
 * @example
 * ```ts
 * decodeAssetJob("group-1/asset-1"); // => { groupId: "group-1", assetId: "asset-1" }
 * ```
 */
function decodeAssetJob(jobId: string): { groupId: string; assetId: string } {
  const slash = jobId.lastIndexOf("/");
  if (slash <= 0 || slash === jobId.length - 1) {
    throw new Error(
      `[ai] ark asset job id "${jobId}" is not valid.\n  Expected "<groupId>/<assetId>" from ark submit.`
    );
  }
  return { groupId: jobId.slice(0, slash), assetId: jobId.slice(slash + 1) };
}

/**
 * Reads one asset's status with `GetAsset`. Also the video preflight's check.
 *
 * @param ctx - Plugin context (config, env).
 * @param assetId - The asset id.
 * @param signal - Caller abort signal.
 * @returns The status and the refusal reason.
 * @throws {RetryableProviderError | TerminalProviderError} From the OpenAPI call.
 */
export async function getAsset(
  ctx: ArkContext,
  assetId: string,
  signal: AbortSignal | undefined
): Promise<ArkAssetStatus> {
  const result = await openApiCall(ctx, "GetAsset", { Id: assetId }, signal);
  return {
    status: readString(result, "Status"),
    failedReason: readString(result, "FailedReason")
  };
}

/**
 * Checks the request and the image locally, then creates the asset in this
 * process's AIGC group.
 *
 * @param ctx - Plugin context.
 * @param request - The registration request.
 * @param signal - Caller abort signal (CreateAsset only; the group is shared).
 * @returns `{ jobId: "<groupId>/<assetId>" }`.
 */
async function submitAsset(
  ctx: ArkContext,
  request: AssetRequest,
  signal: AbortSignal | undefined
): Promise<{ jobId: string }> {
  // Refuse what ark cannot take, before any call.
  checkGroup(request.group);
  const url = checkUrl(request.url);
  const name = assetNameOf(request);
  checkAssetImage(await readAssetImage(request.image), request.image.mimeType, name);

  // One group per process, then the asset from its public URL.
  const groupId = await findOrCreateGroup(ctx);
  const result = await openApiCall(
    ctx,
    "CreateAsset",
    { GroupId: groupId, URL: url, AssetType: "Image", Name: name },
    signal
  );
  const assetId = readString(result, "Id");
  if (assetId === undefined) throw unreadableResponse("CreateAsset");
  return { jobId: `${groupId}/${assetId}` };
}

/**
 * The done poll of an Active asset: the encoded record under `ASSET_MIME`.
 *
 * @param ctx - Plugin context (account, log).
 * @param assetId - The asset id.
 * @param groupId - Its group id.
 * @returns The done poll, cost 0.
 */
function registered(ctx: ArkContext, assetId: string, groupId: string): AssetJobPoll {
  const account = ownAccount(ctx);
  ctx.log.info("ark:asset:registered", { assetId, account });
  const record = { assetId, provider: "ark", account, groupId, registeredAt: Date.now() };
  return {
    state: "done",
    body: encodeAssetRecord(record),
    mimeType: ASSET_MIME,
    costUsd: 0,
    meta: { assetId, account }
  };
}

/**
 * The failed poll of a refused asset: a flagged error naming ark's reason.
 *
 * @param ctx - Plugin context (log).
 * @param request - The registration request (for the name).
 * @param failedReason - ark's `FailedReason`, if any.
 * @returns The failed poll.
 */
function refused(
  ctx: ArkContext,
  request: AssetRequest,
  failedReason: string | undefined
): AssetJobPoll {
  const name = assetNameOf(request);
  const reason = shorten(failedReason) ?? "no reason given";
  ctx.log.warn("ark:asset:refused", { name, reason });
  return {
    state: "failed",
    error: new FlaggedProviderError(
      `[ai] ark refused asset "${name}": ${reason}.\n  Items that use it will not run.`
    )
  };
}

/**
 * Polls a registration once with `GetAsset`: `Processing` is pending,
 * `Active` is done with the record, `Failed` is flagged. Another status stays
 * pending with a warning.
 *
 * @param ctx - Plugin context.
 * @param jobId - The id `submit` returned.
 * @param request - The registration request.
 * @param signal - Caller abort signal.
 * @returns The poll result.
 */
async function pollAsset(
  ctx: ArkContext,
  jobId: string,
  request: AssetRequest,
  signal: AbortSignal | undefined
): Promise<AssetJobPoll> {
  const { groupId, assetId } = decodeAssetJob(jobId);
  const asset = await getAsset(ctx, assetId, signal);

  if (asset.status === "Processing") return PENDING;
  if (asset.status === "Active") return registered(ctx, assetId, groupId);
  if (asset.status === "Failed") return refused(ctx, request, asset.failedReason);

  ctx.log.warn("ark:asset:unknown-status", { assetId, status: asset.status });
  return PENDING;
}

/**
 * Creates the ark asset handler registered under `("asset", "ark")`.
 * `estimate` is always 0: the asset fee is part of the entitlement.
 *
 * @param ctx - Plugin context (config, state, env, log).
 * @returns The handler: estimate, submit and poll.
 */
export function createAssetHandler(ctx: ArkContext): AssetHandler {
  return {
    estimate: (): { usd: number } => ({ usd: 0 }),
    submit: (request: AssetRequest, opts: { signal?: AbortSignal }): Promise<{ jobId: string }> =>
      submitAsset(ctx, request, opts.signal),
    poll: (
      jobId: string,
      request: AssetRequest,
      opts: { signal?: AbortSignal }
    ): Promise<AssetJobPoll> => pollAsset(ctx, jobId, request, opts.signal)
  };
}
