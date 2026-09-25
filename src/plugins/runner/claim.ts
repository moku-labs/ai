/**
 * @file runner claim — cross-run dedupe: one item per artifact key reaches
 * the provider across every active run. A follower waits for the leader's
 * verdict and copies it when it can (done → reuse at cost 0, flagged/failed →
 * recorded without a submit); an `open` verdict passes the key on, and the next
 * claimant adopts any live provider job through the journal.
 */
import type { ItemRow } from "../journal/types";
import { openClaim } from "./state";
import type { ClaimVerdict, DrainController, RunnerContext, UnstampedRunEvent } from "./types";

/** The verdict of an item that stopped without a provider verdict: its claim passes to the next item. */
export const OPEN_VERDICT: ClaimVerdict = { kind: "open" };

/**
 * Cross-run reuse (D2): when a `done` artifact with this item's artifact key
 * exists in any run and its bytes are still in the store, completes the item
 * with it at cost 0 — no provider call, no budget reservation.
 *
 * @param ctx - Runner domain context.
 * @param item - The queued item.
 * @param report - Stream callback.
 * @returns True when the item was completed by reuse.
 * @example
 * ```ts
 * if (await tryReuse(ctx, item, report)) return;
 * ```
 */
export async function tryReuse(
  ctx: RunnerContext,
  item: ItemRow,
  report: (event: UnstampedRunEvent) => void
): Promise<boolean> {
  if (item.artifactKey === null) return false;

  const artifact = ctx.journal.findDoneArtifact(item.artifactKey);
  if (!artifact || !(await ctx.store.has(artifact.contentHash))) return false;

  ctx.journal.reuseDone(item.id, artifact);
  ctx.log.info("runner:reused", { itemId: item.id });
  report({ type: "item:done", itemId: item.id, costUsd: 0, contentHash: artifact.contentHash });
  return true;
}

/** Settles an item's artifact claim with its verdict. */
export type SettleClaim = (verdict: ClaimVerdict) => void;

/**
 * The claim of an item without an artifact key (a legacy row): nothing to
 * share, nothing to settle.
 *
 * @example
 * ```ts
 * settleNothing(); // no claim map change
 * ```
 */
function settleNothing(): void {
  // A row without an artifact key never entered the claim map.
}

/** What a follower's wait ends with when its own run drains first. */
const DRAINED = "drained";

/**
 * Waits for a claim's verdict, or for the drain signal, whichever comes
 * first. The abort listener is removed when the wait ends.
 *
 * @param settled - The leader's claim verdict.
 * @param signal - The follower's drain signal.
 * @returns The verdict, or `"drained"` when the drain signal fired first.
 * @example
 * ```ts
 * await verdictUnlessDrained(leader.settled, drain.signal); // "drained" after a pause
 * ```
 */
async function verdictUnlessDrained(
  settled: Promise<ClaimVerdict>,
  signal: AbortSignal
): Promise<ClaimVerdict | typeof DRAINED> {
  if (signal.aborted) return DRAINED;

  const drained = Promise.withResolvers<typeof DRAINED>();
  /**
   * Ends the wait when the run drains.
   *
   * @example
   * ```ts
   * signal.addEventListener("abort", onAbort, { once: true });
   * ```
   */
  const onAbort = (): void => {
    drained.resolve(DRAINED);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([settled, drained.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Records the leader's `flagged` or `failed` verdict on a follower without a
 * provider call: the same request would get the same verdict and cost money.
 * The gate still runs, so the budget is checked (a refusal triggers the
 * budget stop as usual); no attempt row is written.
 *
 * @param ctx - Runner domain context.
 * @param item - The follower, still `queued`.
 * @param verdict - The leader's verdict.
 * @param drain - The follower's drain controller.
 * @param report - Stream callback.
 * @example
 * ```ts
 * shareVerdict(ctx, item, { kind: "failed", errorClass: "http-4xx" }, drain, report); // item:failed, no submit
 * ```
 */
function shareVerdict(
  ctx: RunnerContext,
  item: ItemRow,
  verdict: Extract<ClaimVerdict, { kind: "flagged" | "failed" }>,
  drain: DrainController,
  report: (event: UnstampedRunEvent) => void
): void {
  const gate = ctx.journal.gateToDispatching(item.id);
  if (!gate.ok) {
    if (gate.reason === "budget") drain.triggerBudgetStop();
    return;
  }

  if (verdict.kind === "flagged") {
    ctx.journal.markFlagged(item.id);
    report({ type: "item:flagged", itemId: item.id });
  } else {
    ctx.journal.markFailed(item.id, { errorClass: verdict.errorClass, terminal: true });
    report({ type: "item:failed", itemId: item.id, errorClass: verdict.errorClass });
  }
  ctx.log.info("runner:dedupe:shared", { itemId: item.id, verdict: verdict.kind });
}

/**
 * Settles a follower with its leader's verdict when that verdict can be
 * copied: `done` reuses the artifact (cost 0), `flagged` / `failed` are
 * recorded without a submit. An `open` verdict, or a `done` whose bytes are
 * gone from the store, cannot be copied.
 *
 * @param ctx - Runner domain context.
 * @param item - The follower.
 * @param verdict - The leader's verdict.
 * @param drain - The follower's drain controller.
 * @param report - Stream callback.
 * @returns True when the follower settled.
 * @example
 * ```ts
 * if (await copyVerdict(ctx, item, { kind: "done" }, drain, report)) return undefined;
 * ```
 */
async function copyVerdict(
  ctx: RunnerContext,
  item: ItemRow,
  verdict: ClaimVerdict,
  drain: DrainController,
  report: (event: UnstampedRunEvent) => void
): Promise<boolean> {
  if (verdict.kind === "open") return false;
  if (verdict.kind === "done") return tryReuse(ctx, item, report);

  shareVerdict(ctx, item, verdict, drain, report);
  return true;
}

/**
 * Makes this item the only one that reaches the provider for its artifact
 * key, across every active run. While another item holds the key, it waits
 * for that item's verdict and copies it when it can; an `open` verdict lets
 * the next waiter claim the key. The last check of the map and the claim
 * happen with no `await` between them, so two waiters never both claim.
 *
 * @param ctx - Runner domain context.
 * @param item - The queued item, `$ref` targets already resolved.
 * @param drain - The item's drain controller.
 * @param report - Stream callback.
 * @returns The claim to settle with this item's verdict, or undefined when the item settled while waiting (verdict copied, or the run is draining and the item stays `queued`).
 * @example
 * ```ts
 * const settleClaim = await claimArtifact(ctx, item, drain, report);
 * if (!settleClaim) return "settled";
 * ```
 */
export async function claimArtifact(
  ctx: RunnerContext,
  item: ItemRow,
  drain: DrainController,
  report: (event: UnstampedRunEvent) => void
): Promise<SettleClaim | undefined> {
  const key = item.artifactKey;
  if (key === null) return settleNothing;

  let waitLogged = false;
  for (let leader = ctx.state.claims.get(key); leader; leader = ctx.state.claims.get(key)) {
    if (!waitLogged) {
      ctx.log.info("runner:dedupe:wait", { itemId: item.id, leader: leader.itemId });
      waitLogged = true;
    }

    const verdict = await verdictUnlessDrained(leader.settled, drain.signal);
    if (verdict === DRAINED) return undefined;
    if (await copyVerdict(ctx, item, verdict, drain, report)) return undefined;
  }

  return openClaim(ctx.state, key, item.id);
}
