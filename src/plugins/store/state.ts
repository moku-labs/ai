/**
 * @file store core plugin — state factory skeleton.
 */
import type { State } from "./types";

/**
 * Creates initial store state (root dir not yet verified).
 *
 * @returns Initial store state.
 * @example
 * ```ts
 * const state = createStoreState();
 * ```
 */
export function createStoreState(): State {
  return { rootEnsured: false };
}
