/**
 * @file ark provider plugin — state factory.
 */
import type { State } from "./types";

/**
 * Creates the initial ark state: no AIGC group yet, no account fingerprint
 * yet, no asset seen Active, and no one-time warning logged yet.
 *
 * @returns Initial ark state.
 * @example
 * ```ts
 * createArkState().group.size; // => 0
 * ```
 */
export function createArkState(): State {
  return {
    group: new Map(),
    // eslint-disable-next-line unicorn/no-null -- State.account is `X | null`: null is "not computed yet"
    account: null,
    activeAssets: new Set(),
    negativeWarned: false,
    imageNegativeWarned: false,
    ratioWarned: false,
    journalSkipLogged: false
  };
}
