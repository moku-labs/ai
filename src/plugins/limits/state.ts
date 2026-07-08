/**
 * @file limits core plugin — state factory skeleton.
 */
import type { State } from "./types";

/**
 * Creates initial limits state (no lanes until first acquire).
 *
 * @returns Initial limits state.
 * @example
 * ```ts
 * const state = createLimitsState();
 * ```
 */
export function createLimitsState(): State {
  return { lanes: new Map() };
}
