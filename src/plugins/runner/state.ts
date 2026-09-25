/**
 * @file runner plugin — state factory, the active-run map and the artifact
 * claim map (one provider call per artifact key across every active run).
 */
import type { ActiveRun, Claim, ClaimVerdict, State } from "./types";

/**
 * Creates initial runner state: no active run, no stream consumer, no claim.
 *
 * @returns Initial runner state.
 * @example
 * ```ts
 * createRunnerState().active.size; // 0
 * ```
 */
export function createRunnerState(): State {
  return { active: new Map(), subscribers: new Set(), claims: new Map() };
}

/**
 * Registers a run this process starts driving. Map order is start order, so
 * the last entry is the newest active run.
 *
 * @param state - Runner state.
 * @param runId - The run's id.
 * @param signal - The caller's abort signal, if any.
 * @returns The run's live bookkeeping.
 * @example
 * ```ts
 * addActiveRun(createRunnerState(), "run-1", undefined); // { runId: "run-1", signal: undefined, inFlight: 0 }
 * ```
 */
export function addActiveRun(
  state: State,
  runId: string,
  signal: AbortSignal | undefined
): ActiveRun {
  const active: ActiveRun = { runId, signal, inFlight: 0 };
  state.active.set(runId, active);
  return active;
}

/**
 * Removes one run from the active runs; the others keep running.
 *
 * @param state - Runner state.
 * @param runId - The run that ended.
 * @example
 * ```ts
 * removeActiveRun(state, "run-1"); // state.active no longer has "run-1"
 * ```
 */
export function removeActiveRun(state: State, runId: string): void {
  state.active.delete(runId);
}

/**
 * Claims an artifact key for one item: other items with the same key wait on
 * `settled` instead of calling the provider. The returned function settles
 * the claim with the item's verdict. It frees the key first, so the first
 * follower to wake finds it free and can claim it. A newer claim on the same
 * key is never removed.
 *
 * @param state - Runner state.
 * @param artifactKey - The item's artifact key.
 * @param itemId - The claiming item.
 * @returns Settles the claim with the item's verdict.
 * @example
 * ```ts
 * const settle = openClaim(state, "ak-1", "item-1"); // state.claims.get("ak-1")?.itemId === "item-1"
 * settle({ kind: "done" }); // key freed; followers reuse the artifact
 * ```
 */
export function openClaim(
  state: State,
  artifactKey: string,
  itemId: string
): (verdict: ClaimVerdict) => void {
  const { promise, resolve } = Promise.withResolvers<ClaimVerdict>();
  const claim: Claim = { itemId, settled: promise };
  state.claims.set(artifactKey, claim);

  return verdict => {
    if (state.claims.get(artifactKey) === claim) state.claims.delete(artifactKey);
    resolve(verdict);
  };
}
