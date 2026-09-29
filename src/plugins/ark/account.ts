/**
 * @file ark account fingerprint. An asset id is valid only in the account
 * that registered it, so a stored asset record carries a fingerprint of that
 * account. It is a one-way hash: it never contains the key and cannot be
 * turned back into it. The region is part of it, because the same key string
 * in two regions is two accounts.
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
