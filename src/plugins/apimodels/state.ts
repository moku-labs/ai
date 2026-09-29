/**
 * @file apimodels provider plugin — state factory.
 */
import type { State } from "./types";

/**
 * Creates initial apimodels state: price table not yet computed, empty
 * upload, asset and group caches, no journal skip logged yet.
 *
 * @returns Initial apimodels state.
 */
export function createApimodelsState(): State {
  return {
    // eslint-disable-next-line unicorn/no-null -- State.prices is `X | null`: null is the "not computed yet" sentinel
    prices: null,
    uploads: new Map(),
    assets: new Map(),
    groups: new Map(),
    journalSkipLogged: false
  };
}
