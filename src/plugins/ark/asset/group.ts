/**
 * @file ark AIGC asset group — one group id per process: `config.groupId`
 * when set, else one `CreateAssetGroup` on the first registration of the
 * process (single-flight, so concurrent registrations share it). The new id
 * is logged so the user can set `groupId` and reuse it: an account holds at
 * most 50 groups. `ListAssetGroups` is not used: it is not in the researched
 * action list.
 */
import { openApiCall, readString, unreadableResponse } from "../client";
import type { ArkContext } from "../types";

/** Hint logged with a newly created group id. */
const GROUP_CREATED_HINT = "set ark config groupId to reuse it";

/**
 * Creates the AIGC group named `config.groupName` and logs its id.
 *
 * @param ctx - Plugin context (config, env, log).
 * @returns The new group id.
 * @throws {RetryableProviderError | TerminalProviderError} From the OpenAPI call, or 502 when no Id comes back.
 */
async function createGroup(ctx: ArkContext): Promise<string> {
  const result = await openApiCall(ctx, "CreateAssetGroup", {
    GroupType: "AIGC",
    Name: ctx.config.groupName
  });
  const groupId = readString(result, "Id");
  if (groupId === undefined) throw unreadableResponse("CreateAssetGroup");

  ctx.log.warn("ark:asset:group-created", { groupId, hint: GROUP_CREATED_HINT });
  return groupId;
}

/**
 * Starts the group lookup: the configured id, or a creation that forgets
 * itself on failure, so the next registration tries again. It runs without
 * the caller's signal: other registrations wait on the same promise.
 *
 * @param ctx - Plugin context.
 * @returns The group id promise.
 */
function startGroup(ctx: ArkContext): Promise<string> {
  if (ctx.config.groupId !== null) return Promise.resolve(ctx.config.groupId);

  return createGroup(ctx).catch((error: unknown) => {
    // eslint-disable-next-line unicorn/no-null -- State.group is `X | null`: null is "not created yet"
    ctx.state.group = null;
    throw error;
  });
}

/**
 * The AIGC group id of this process: `config.groupId`, or the group created
 * once by the first registration. Concurrent callers share one promise.
 *
 * @param ctx - Plugin context (config, state, env, log).
 * @returns The group id.
 */
export function findOrCreateGroup(ctx: ArkContext): Promise<string> {
  ctx.state.group ??= startGroup(ctx);
  return ctx.state.group;
}
