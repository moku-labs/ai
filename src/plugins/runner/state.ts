/**
 * @file runner plugin — state factory + the "no active run" sentinel helper.
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

/**
 * Clears the active run back to the "no active run" sentinel. Centralizes
 * the one `unicorn/no-null` exception for this assignment (`State.active`
 * is `ActiveRun | null` by spec), so `run()`/`resume()` don't each need
 * their own disable comment.
 *
 * @param state - Runner state to clear.
 * @example
 * ```ts
 * clearActiveRun(ctx.state);
 * ```
 */
export function clearActiveRun(state: State): void {
  // eslint-disable-next-line unicorn/no-null -- see createRunnerState; the single source of the null literal for this file
  state.active = null;
}
