/**
 * @file elevenlabs provider plugin — state factory.
 */
import type { State } from "./types";

/**
 * Creates initial elevenlabs state (price table not yet computed).
 *
 * @returns Initial elevenlabs state.
 * @example
 * ```ts
 * const state = createElevenlabsState();
 * ```
 */
export function createElevenlabsState(): State {
  // eslint-disable-next-line unicorn/no-null -- spec/10 pins null as the "not computed yet" sentinel (State.prices is `X | null`)
  return { prices: null };
}
