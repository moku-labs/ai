/**
 * @file runner pipeline — per-item execution: admit(limits) → gate(journal,
 * atomic) → execute(handler) → persist(store+journal) → report. Owns the
 * runner's single audited dynamic boundary (`isExecutableHandler`) and the
 * per-item retry loop (a retryable attempt re-enters admit+gate, per the
 * durable state machine — `markFailed` returns the item to `queued`).
 */
import { createHash } from "node:crypto";
import type { AttemptOutcome, ErrorClass, ItemRow } from "../journal/types";
import { registryPlugin } from "../registry";
import { backoffMs, classifyError, isRetryableErrorClass, retryAfterMsOf } from "./retry";
import type {
  ActiveRun,
  DrainController,
  ExecutableHandler,
  HandlerRequest,
  RunEvent,
  RunnerContext
} from "./types";

/** Discriminated outcome of a single provider attempt. */
type AttemptOutcomeResult =
  | { kind: "done"; costUsd: number; contentHash: string }
  | { kind: "flagged" }
  | { kind: "terminal-failed"; errorClass: ErrorClass }
  | { kind: "retryable"; errorClass: ErrorClass; retryAfterMs: number | undefined };

/**
 * Deep-sorts every object's keys (arrays keep their order) so structurally
 * equal values serialize identically regardless of key insertion order.
 *
 * @param value - Any JSON-serializable value.
 * @returns A structurally equivalent value with object keys sorted.
 * @example
 * ```ts
 * sortKeysDeep({ b: 1, a: 2 }); // => { a: 2, b: 1 }
 * ```
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => sortKeysDeep(item));
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).toSorted()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Serializes a value to key-order-independent canonical JSON.
 *
 * @param value - Any JSON-serializable value.
 * @returns The canonical JSON text.
 * @example
 * ```ts
 * canonicalJson({ task: "voiceover", input: { text: "hi" } });
 * ```
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * Hex-encoded sha256 digest of a UTF-8 string.
 *
 * @param text - Text to hash.
 * @returns The 64-character lowercase hex digest.
 * @example
 * ```ts
 * sha256Hex("hello");
 * ```
 */
function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Runtime shape guard narrowing a registry-resolved handler (`unknown`) to
 * the {@link ExecutableHandler} protocol. This — together with
 * {@link resolveHandler} — is the runner's single audited dynamic boundary
 * (spec/06; spec/09 R9): the registry itself never types what it transports,
 * so every task/provider handler is validated here, once, before use.
 *
 * @param value - The value resolved from `registry.resolve(task, provider)`.
 * @returns Whether `value` exposes callable `estimate`/`execute` members.
 * @example
 * ```ts
 * if (isExecutableHandler(handler)) await handler.execute(request, {});
 * ```
 */
export function isExecutableHandler(value: unknown): value is ExecutableHandler {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { estimate?: unknown; execute?: unknown };
  return typeof candidate.estimate === "function" && typeof candidate.execute === "function";
}

/**
 * Resolves and narrows the handler registered for `task`/`provider`.
 *
 * @param ctx - Runner domain context.
 * @param task - Task key, e.g. "voiceover".
 * @param provider - Provider name, e.g. "elevenlabs".
 * @returns The narrowed, executable handler.
 * @throws {Error} When no handler is registered, or it doesn't satisfy the protocol.
 * @example
 * ```ts
 * const handler = resolveHandler(ctx, "voiceover", "elevenlabs");
 * ```
 */
export function resolveHandler(
  ctx: RunnerContext,
  task: string,
  provider: string
): ExecutableHandler {
  const handler = ctx.require(registryPlugin).resolve(task, provider);
  if (!isExecutableHandler(handler)) {
    throw new Error(
      `[ai] No executable handler registered for "${task}/${provider}".\n  Call registry.register("${task}", "${provider}", handler) with an object exposing estimate()/execute().`
    );
  }
  return handler;
}

/**
 * Computes an item's artifact identity key from its planning key, resolved
 * provider, and pack version.
 *
 * @param planningKey - The item's planning key.
 * @param provider - The item's resolved provider.
 * @param packVersion - The item's pack version, or null when unset.
 * @returns The artifact key.
 * @example
 * ```ts
 * artifactKeyOf(planningKey, "elevenlabs", null);
 * ```
 */
export function artifactKeyOf(
  planningKey: string,
  provider: string,
  packVersion: string | null
): string {
  return sha256Hex(canonicalJson({ planningKey, provider, packVersion }));
}

/**
 * Builds the lane key for an item: `"{task}/{provider}/default"` (M0 has no
 * account pools yet — every lane uses the literal `"default"` account).
 *
 * @param item - The item to compute a lane for.
 * @returns The lane key.
 * @example
 * ```ts
 * laneOf(item); // => "voiceover/elevenlabs/default"
 * ```
 */
function laneOf(item: ItemRow): string {
  return `${item.task}/${item.provider}/default`;
}

/**
 * Waits for lane capacity, translating an abort or breaker-open rejection
 * into `undefined` instead of a thrown error.
 *
 * @param ctx - Runner domain context.
 * @param lane - Lane key to acquire capacity on.
 * @param signal - Drain signal; aborts the wait cleanly.
 * @returns The release handle, or undefined when the wait was aborted or the breaker is open.
 * @example
 * ```ts
 * const admission = await acquireLane(ctx, lane, drain.signal);
 * ```
 */
async function acquireLane(
  ctx: RunnerContext,
  lane: string,
  signal: AbortSignal
): Promise<{ release: () => void } | undefined> {
  try {
    return await ctx.limits.acquire(lane, { signal });
  } catch {
    return undefined;
  }
}

/**
 * Resolves after `ms` milliseconds, or immediately when `signal` is already
 * aborted or fires during the wait.
 *
 * @param ms - Delay in milliseconds.
 * @param signal - Drain signal; aborts the wait cleanly.
 * @returns Resolves once the delay elapses or the signal aborts.
 * @example
 * ```ts
 * await delay(1_000, drain.signal);
 * ```
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/**
 * Creates a drain controller merging an optional external abort signal with
 * an internal budget-stop trigger into one signal the pipeline can select on.
 *
 * @param externalSignal - The caller-supplied `opts.signal`, if any.
 * @returns A controller exposing the merged signal, a `budgetStopped` flag, and the trigger.
 * @example
 * ```ts
 * const drain = createDrainController(opts?.signal);
 * ```
 */
export function createDrainController(externalSignal: AbortSignal | undefined): DrainController {
  const internal = new AbortController();
  let budgetStopped = false;

  if (externalSignal?.aborted) {
    internal.abort();
  } else {
    externalSignal?.addEventListener("abort", () => internal.abort(), { once: true });
  }

  return {
    /**
     * The merged abort signal: fires on external abort or `triggerBudgetStop()`.
     *
     * @returns The merged `AbortSignal`.
     * @example
     * ```ts
     * drain.signal.aborted;
     * ```
     */
    get signal(): AbortSignal {
      return internal.signal;
    },
    /**
     * Whether `triggerBudgetStop()` has fired for this drain.
     *
     * @returns True once the budget-stop trigger has fired.
     * @example
     * ```ts
     * drain.budgetStopped;
     * ```
     */
    get budgetStopped(): boolean {
      return budgetStopped;
    },
    /**
     * Fires the merged signal for a budget-stop drain. A no-op after the
     * first call.
     *
     * @example
     * ```ts
     * drain.triggerBudgetStop();
     * ```
     */
    triggerBudgetStop(): void {
      if (budgetStopped) return;
      budgetStopped = true;
      internal.abort();
    }
  };
}

/**
 * Maps an error class to its attempt outcome: content-policy is `flagged`,
 * the other retryable classes are `retryable-error`, everything else is a
 * `terminal-error`.
 *
 * @param errorClass - The classified error class.
 * @returns The attempt outcome for `errorClass`.
 * @example
 * ```ts
 * outcomeOf("http-5xx"); // => "retryable-error"
 * ```
 */
function outcomeOf(errorClass: ErrorClass): AttemptOutcome {
  if (errorClass === "content-policy") return "flagged";
  if (isRetryableErrorClass(errorClass)) return "retryable-error";
  return "terminal-error";
}

/**
 * Classifies a failed attempt's error, records it on the attempt row,
 * transitions the item for the two outcomes it can fully decide
 * (`flagged`, terminal `failed`), and reports the breaker outcome for
 * retryable failures. The retryable-vs-exhausted decision is left to the
 * caller, which tracks the cross-attempt count.
 *
 * @param ctx - Runner domain context.
 * @param item - The item the failed attempt belongs to.
 * @param lane - The item's lane key.
 * @param attemptId - The attempt row id, from `journal.recordAttempt`.
 * @param error - The error thrown by `handler.execute`.
 * @returns The attempt's outcome.
 * @example
 * ```ts
 * const outcome = handleAttemptError(ctx, item, lane, attemptId, error);
 * ```
 */
function handleAttemptError(
  ctx: RunnerContext,
  item: ItemRow,
  lane: string,
  attemptId: number,
  error: unknown
): AttemptOutcomeResult {
  const errorClass = classifyError(error);
  const outcome = outcomeOf(errorClass);

  ctx.journal.finishAttempt(attemptId, { endedAt: Date.now(), outcome, errorClass });

  if (outcome === "flagged") {
    ctx.journal.markFlagged(item.id);
    return { kind: "flagged" };
  }
  if (outcome === "terminal-error") {
    ctx.journal.markFailed(item.id, { errorClass, terminal: true });
    return { kind: "terminal-failed", errorClass };
  }

  ctx.limits.reportOutcome(lane, "retryable-error");
  return { kind: "retryable", errorClass, retryAfterMs: retryAfterMsOf(error) };
}

/**
 * Runs one provider attempt for an item already gated to `dispatching`:
 * records the attempt, calls `handler.execute`, and on success persists the
 * artifact (`store.put` → `journal.commitDone`) and reports the breaker
 * outcome. On failure, classifies and transitions via {@link handleAttemptError}.
 *
 * @param ctx - Runner domain context.
 * @param item - The item, already `dispatching`.
 * @param request - The item's request payload (input/params — never journaled).
 * @param signal - Drain signal, forwarded to `handler.execute`.
 * @returns The attempt's outcome.
 * @example
 * ```ts
 * const outcome = await attemptOnce(ctx, item, request, drain.signal);
 * ```
 */
async function attemptOnce(
  ctx: RunnerContext,
  item: ItemRow,
  request: HandlerRequest,
  signal: AbortSignal
): Promise<AttemptOutcomeResult> {
  const handler = resolveHandler(ctx, item.task, item.provider);
  const lane = laneOf(item);
  const attemptId = ctx.journal.recordAttempt(item.id, {
    provider: item.provider,
    account: "default",
    startedAt: Date.now()
  });

  try {
    const result = await handler.execute(request, { signal });
    ctx.journal.finishAttempt(attemptId, {
      endedAt: Date.now(),
      outcome: "done",
      costUsd: result.costUsd
    });
    ctx.limits.reportOutcome(lane, "ok");

    const putResult = await ctx.store.put(result.body);
    ctx.journal.commitDone(item.id, {
      actualCostUsd: result.costUsd,
      artifactKey: artifactKeyOf(item.planningKey, item.provider, item.packVersion),
      contentHash: putResult.hash
    });
    return { kind: "done", costUsd: result.costUsd, contentHash: putResult.hash };
  } catch (error) {
    return handleAttemptError(ctx, item, lane, attemptId, error);
  }
}

/** Sentinel returned by {@link applyOutcome}: `true` means the item reached a terminal state. */
type OutcomeApplied = { terminal: true } | { terminal: false; attempt: number; waitMs: number };

/**
 * Applies one attempt's outcome: reports the matching stream event for a
 * terminal outcome (`done`/`flagged`/`terminal-failed`), or — for a
 * retryable outcome — either exhausts `maxAttempts` (terminal `failed`) or
 * transitions the item back to `queued` and reports `item:retry` with the
 * computed backoff delay. Extracted from {@link executeItem} to keep its
 * loop body flat.
 *
 * @param ctx - Runner domain context.
 * @param item - The item the attempt belongs to.
 * @param maxAttempts - The effective per-item attempt ceiling.
 * @param attempt - The attempt count going into this outcome (before increment).
 * @param outcome - The attempt's outcome.
 * @param report - Callback invoked with the resulting stream event.
 * @returns Whether the item reached a terminal state, or the next attempt count and backoff delay.
 * @example
 * ```ts
 * const applied = applyOutcome(ctx, item, maxAttempts, attempt, outcome, report);
 * ```
 */
function applyOutcome(
  ctx: RunnerContext,
  item: ItemRow,
  maxAttempts: number,
  attempt: number,
  outcome: AttemptOutcomeResult,
  report: (event: RunEvent) => void
): OutcomeApplied {
  if (outcome.kind === "done") {
    report({
      type: "item:done",
      itemId: item.id,
      costUsd: outcome.costUsd,
      contentHash: outcome.contentHash
    });
    return { terminal: true };
  }
  if (outcome.kind === "flagged") {
    report({ type: "item:flagged", itemId: item.id });
    return { terminal: true };
  }
  if (outcome.kind === "terminal-failed") {
    report({ type: "item:failed", itemId: item.id, errorClass: outcome.errorClass });
    return { terminal: true };
  }

  const nextAttempt = attempt + 1;
  if (nextAttempt >= maxAttempts) {
    ctx.journal.markFailed(item.id, { errorClass: outcome.errorClass, terminal: true });
    report({ type: "item:failed", itemId: item.id, errorClass: outcome.errorClass });
    return { terminal: true };
  }

  ctx.journal.markFailed(item.id, { errorClass: outcome.errorClass, terminal: false });
  report({
    type: "item:retry",
    itemId: item.id,
    errorClass: outcome.errorClass,
    attempt: nextAttempt
  });
  const waitMs = backoffMs(nextAttempt, ctx.config.retryBaseMs, outcome.retryAfterMs);
  return { terminal: false, attempt: nextAttempt, waitMs };
}

/**
 * Drives one item through the durable pipeline to a terminal outcome:
 * admit(limits.acquire) → gate(journal.gateToDispatching, atomic) →
 * execute → persist → report, looping on retryable failures (each retry
 * re-enters admit+gate, since `markFailed` returns the item to `queued`)
 * until it reaches `done`/`failed`/`flagged`, exhausts `maxAttempts`, or the
 * drain signal aborts (leaving it `queued` for a future run). Reports every
 * transition via `report`, including the initial `item:queued` marker.
 *
 * @param ctx - Runner domain context.
 * @param item - The queued item row to execute.
 * @param request - The item's request payload (input/params — never journaled).
 * @param maxAttempts - The effective per-item attempt ceiling.
 * @param drain - The run's drain controller (abort + budget-stop signal).
 * @param active - The active run's live bookkeeping (in-flight counter).
 * @param report - Callback invoked with every per-item stream record.
 * @example
 * ```ts
 * await executeItem(ctx, item, request, 3, drain, active, report);
 * ```
 */
export async function executeItem(
  ctx: RunnerContext,
  item: ItemRow,
  request: HandlerRequest,
  maxAttempts: number,
  drain: DrainController,
  active: ActiveRun,
  report: (event: RunEvent) => void
): Promise<void> {
  report({ type: "item:queued", itemId: item.id, task: item.task, provider: item.provider });

  let attempt = item.attemptCount;
  while (!drain.signal.aborted) {
    active.inFlight += 1;
    try {
      const lane = laneOf(item);
      const admission = await acquireLane(ctx, lane, drain.signal);
      if (!admission) return;

      try {
        const gate = ctx.journal.gateToDispatching(item.id);
        if (!gate.ok) {
          if (gate.reason === "budget") drain.triggerBudgetStop();
          return;
        }
        report({ type: "item:dispatching", itemId: item.id });

        const outcome = await attemptOnce(ctx, item, request, drain.signal);
        const applied = applyOutcome(ctx, item, maxAttempts, attempt, outcome, report);
        if (applied.terminal) return;

        attempt = applied.attempt;
        await delay(applied.waitMs, drain.signal);
      } finally {
        admission.release();
      }
    } finally {
      active.inFlight -= 1;
    }
  }
}
