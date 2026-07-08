/**
 * @file runner plugin — state factory skeleton.
 */
import type { State } from "./types";

/**
 * Creates initial runner state (no active run).
 *
 * @returns Initial runner state.
 * @example
 * ```ts
 * const state = createRunnerState();
 * ```
 */
export function createRunnerState(): State {
  // eslint-disable-next-line unicorn/no-null -- spec/06 pins null as the "no active run" sentinel (State.active is `ActiveRun | null`)
  return { active: null };
}
