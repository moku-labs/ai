/**
 * @file ark AIGC asset groups — `config.groupId` for `config.groupName`
 * when set; otherwise list all pages for the requested name, reuse the
 * oldest exact match, or create and log a group when none exists. One
 * promise per name shares concurrent lookups; failures forget that name.
 */
import { openApiCall, readString, unreadableResponse } from "../client";
import type { ArkContext } from "../types";
import { walkAssetPages } from "./pages";

/** Hint logged with a newly created group id. */
const GROUP_CREATED_HINT = "set ark config groupId to reuse it";

/** An exact-name group with a usable id and its optional creation time. */
type Group = {
  id: string;
  createTime: string | undefined;
};

/**
 * Keeps the oldest exact-name group across pages; an undated group sorts last.
 *
 * @param items - Untrusted groups on this page.
 * @param name - The exact name to match.
 * @param oldest - The best match from earlier pages.
 * @returns The oldest matching group with a string id, if any.
 */
function oldestGroupIn(
  items: unknown[],
  name: string,
  oldest: Group | undefined
): Group | undefined {
  for (const item of items) {
    if (readString(item, "Name") !== name) continue;
    const id = readString(item, "Id");
    if (id === undefined) continue;

    const createTime = readString(item, "CreateTime");
    const isEarlier =
      oldest === undefined ||
      (createTime !== undefined &&
        (oldest.createTime === undefined || createTime < oldest.createTime));
    if (isEarlier) oldest = { id, createTime };
  }
  return oldest;
}

/**
 * Finds the oldest exact-name AIGC group across every numbered page.
 *
 * @param ctx - Plugin context (config, env).
 * @param name - The group name.
 * @returns The existing group id, or undefined when none matches.
 */
async function findGroup(ctx: ArkContext, name: string): Promise<string | undefined> {
  let oldest: Group | undefined;
  await walkAssetPages(
    (pageNumber, pageSize) =>
      openApiCall(ctx, "ListAssetGroups", {
        Filter: { GroupType: "AIGC", Name: name },
        PageNumber: pageNumber,
        PageSize: pageSize
      }),
    items => {
      oldest = oldestGroupIn(items, name, oldest);
    }
  );
  return oldest?.id;
}

/**
 * Creates the requested AIGC group and logs its id.
 *
 * @param ctx - Plugin context (config, env, log).
 * @param name - The group name.
 * @returns The new group id.
 * @throws {RetryableProviderError | TerminalProviderError} From the OpenAPI call, or 502 when no Id comes back.
 */
async function createGroup(ctx: ArkContext, name: string): Promise<string> {
  const result = await openApiCall(ctx, "CreateAssetGroup", {
    GroupType: "AIGC",
    Name: name
  });
  const groupId = readString(result, "Id");
  if (groupId === undefined) throw unreadableResponse("CreateAssetGroup");

  ctx.log.warn("ark:asset:group-created", { groupId, hint: GROUP_CREATED_HINT });
  return groupId;
}

/**
 * Reuses a matching group, or creates one when none exists.
 *
 * @param ctx - Plugin context.
 * @param name - The group name.
 * @returns The group id promise.
 */
async function startGroup(ctx: ArkContext, name: string): Promise<string> {
  const groupId = await findGroup(ctx, name);
  return groupId ?? createGroup(ctx, name);
}

/**
 * Resolves an AIGC group by name. Concurrent callers share one promise per
 * name without a caller signal; a failure lets the next caller try again.
 *
 * @param ctx - Plugin context (config, state, env, log).
 * @param name - The requested name, defaulting to config.groupName.
 * @returns The group id.
 * @example
 * ```ts
 * const groupId = await findOrCreateGroup(ctx, "portraits");
 * ```
 */
export function findOrCreateGroup(ctx: ArkContext, name = ctx.config.groupName): Promise<string> {
  const usesConfiguredGroup = name === ctx.config.groupName && ctx.config.groupId !== null;
  if (usesConfiguredGroup) return Promise.resolve(ctx.config.groupId);

  const cached = ctx.state.group.get(name);
  if (cached !== undefined) return cached;

  const pending = startGroup(ctx, name).catch((error: unknown) => {
    ctx.state.group.delete(name);
    throw error;
  });
  ctx.state.group.set(name, pending);
  return pending;
}
