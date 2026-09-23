/**
 * @file codex provider plugin — state factory.
 */
import type { State } from "./types";

/**
 * Creates initial codex state (price table not yet computed).
 *
 * @returns Initial codex state.
 * @example
 * ```ts
 * const state = createCodexState();
 * ```
 */
export function createCodexState(): State {
  // eslint-disable-next-line unicorn/no-null -- State.prices is `X | null`; null means "not computed yet"
  return { prices: null };
}
