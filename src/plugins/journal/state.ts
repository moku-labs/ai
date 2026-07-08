/**
 * @file journal core plugin — state factory skeleton.
 */
import type { State } from "./types";

/**
 * Creates initial journal state (no connection until onStart).
 *
 * @returns Initial journal state.
 * @example
 * ```ts
 * const state = createJournalState();
 * ```
 */
export function createJournalState(): State {
  // eslint-disable-next-line unicorn/no-null -- spec/01 pins null as the "not opened yet" sentinel (State fields are `X | null`)
  return { driver: null, checkpointTimer: null };
}
