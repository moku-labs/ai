/**
 * @file fal provider plugin — state factory.
 */
import type { State } from "./types";

/**
 * Creates initial fal state (price table not yet computed, upload cache empty).
 *
 * @returns Initial fal state.
 * @example
 * ```ts
 * const state = createFalState(); // => { prices: null, uploads: Map(0) {} }
 * ```
 */
export function createFalState(): State {
  // eslint-disable-next-line unicorn/no-null -- State.prices is `X | null`: null is the "not computed yet" sentinel
  return { prices: null, uploads: new Map() };
}
