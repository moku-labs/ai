/**
 * @file runner plugin — state factory, the active-run map (and the stop that
 * drains it) and the artifact claim map (one provider call per artifact key
 * across every active run).
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
 * the last entry is the newest active run. The run gets its own stop
 * controller and a `settled` promise it resolves with `settle()` once it ended.
 *
 * @param state - Runner state.
 * @param runId - The run's id.
 * @param signal - The caller's abort signal, if any.
 * @returns The run's live bookkeeping.
 * @example
 * ```ts
 * const active = addActiveRun(createRunnerState(), "run-1", undefined);
 * active.stop.signal.aborted; // false until app.stop()
 * ```
 */
export function addActiveRun(
  state: State,
  runId: string,
  signal: AbortSignal | undefined
): ActiveRun {
  const { promise, resolve } = Promise.withResolvers<void>();
  const active: ActiveRun = {
    runId,
    signal,
    inFlight: 0,
    stop: new AbortController(),
    settled: promise,
    settle: resolve
  };
  state.active.set(runId, active);
  return active;
}

/**
 * Stops every run this process drives: aborts each run's stop signal, so it
 * drains to `paused` like a caller abort, then waits until every run settled.
 * An in-flight provider job stays `submitted`, so a later `resume()` adopts it.
 * A run that starts while it waits is stopped and awaited too.
 *
 * @param state - Runner state.
 * @returns Resolves once every active run settled; at once when none is active.
 * @example
 * ```ts
 * await stopActiveRuns(state); // state.active is empty, every run resolved paused
 * ```
 */
export async function stopActiveRuns(state: State): Promise<void> {
  const stopped = new Set<ActiveRun>();
  /**
   * The active runs this stop has not aborted yet.
   *
   * @returns Those runs, in start order.
   * @example
   * ```ts
   * notStoppedYet(); // [] once every run started before or during the stop was aborted
   * ```
   */
  const notStoppedYet = (): ActiveRun[] =>
    [...state.active.values()].filter(active => !stopped.has(active));

  // Runs can start while earlier ones drain, so repeat until none is left.
  for (let runs = notStoppedYet(); runs.length > 0; runs = notStoppedYet()) {
    for (const active of runs) {
      active.stop.abort();
      stopped.add(active);
    }
    await Promise.allSettled(runs.map(active => active.settled));
  }
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
