/**
 * @file ark account fingerprint. An asset id is valid only in the account
 * that registered it, so a stored asset record carries a fingerprint of that
 * account. It is a one-way hash: it never contains the key and cannot be
 * turned back into it. The region is part of it, because the same key string
 * in two regions is two accounts. The API key gets its own fingerprint
 * ({@link apiAccountOf}): a draft task id is valid only for the API key that
 * made it. {@link isSet} tells whether a key is there at all, without throwing.
 */
import { createHash } from "node:crypto";
import type { ArkContext, ArkRegion } from "./types";

/** Length of the fingerprint, in hex characters. */
const FINGERPRINT_LENGTH = 12;

/**
 * The account fingerprint: the first 12 hex characters of
 * `sha256("moku-ai:" + region + ":" + accessKey)`.
 *
 * @param region - The Ark region.
 * @param accessKey - The access key id.
 * @returns 12 lowercase hex characters.
 * @example
 * ```ts
 * accountOf("intl", "AKLTtestaccesskey"); // => "1aea36531116"
 * ```
 */
export function accountOf(region: ArkRegion, accessKey: string): string {
  return createHash("sha256")
    .update(`moku-ai:${region}:${accessKey}`)
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);
}

/**
 * The API-key fingerprint that scopes a draft record: the first 12 hex
 * characters of `sha256("moku-ai:api:" + region + ":" + apiKey)`. One-way; it
 * never contains the key.
 *
 * @param region - The Ark region.
 * @param apiKey - The Ark API key.
 * @returns 12 lowercase hex characters.
 * @example
 * ```ts
 * apiAccountOf("intl", "test-ark-api-key"); // => "d1b474b7c3d4"
 * ```
 */
export function apiAccountOf(region: ArkRegion, apiKey: string): string {
  return createHash("sha256")
    .update(`moku-ai:api:${region}:${apiKey}`)
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);
}

/**
 * Whether an env var holds a non-empty value. Reads through `ctx.env.get`,
 * so it never throws.
 *
 * @param ctx - Plugin context (env).
 * @param name - The env var name.
 * @returns True when set and not empty.
 */
export function isSet(ctx: ArkContext, name: string): boolean {
  const value = ctx.env.get(name);
  return value !== undefined && value !== "";
}

/**
 * This instance's account fingerprint, computed once per process from the
 * configured region and the access key read through `ctx.env` (MC3).
 *
 * @param ctx - Plugin context (config, state, env).
 * @returns The fingerprint.
 * @throws {Error} The env error when the access key is not set.
 */
export function ownAccount(ctx: ArkContext): string {
  if (ctx.state.account === null) {
    const accessKey = ctx.env.require(ctx.config.accessKeyEnv);
    ctx.state.account = accountOf(ctx.config.region, accessKey);
  }
  return ctx.state.account;
}
