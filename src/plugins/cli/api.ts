/**
 * @file cli plugin — API factory skeleton (dispatch + CommandContext assembly).
 */
import type { CliApi } from "./types";

/**
 * Creates the cli API surface (dispatch/commands).
 *
 * @param _ctx - Plugin context (unused in skeleton).
 * @example
 * ```ts
 * const api = createCliApi(ctx);
 * ```
 */
export function createCliApi(_ctx: unknown): CliApi {
  throw new Error("not implemented");
}
