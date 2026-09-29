/**
 * @file ark provider plugin — state factory.
 */
import type { State } from "./types";

/**
 * Creates the initial ark state: no AIGC group yet, no account fingerprint
 * yet, no asset seen Active, and the negative-prompt warning not yet logged.
 *
 * @returns Initial ark state.
 */
export function createArkState(): State {
  return {
    // eslint-disable-next-line unicorn/no-null -- State.group is `X | null`: null is "not created yet"
    group: null,
    // eslint-disable-next-line unicorn/no-null -- State.account is `X | null`: null is "not computed yet"
    account: null,
    activeAssets: new Set(),
    negativeWarned: false
  };
}
