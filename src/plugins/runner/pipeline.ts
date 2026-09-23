/**
 * @file runner pipeline — per-item execution: admit(limits) → gate(journal,
 * atomic) → execute(handler) → persist(store+journal) → report. Owns the
 * runner's single audited dynamic boundary (`isExecutableHandler`) and the
 * per-item retry loop (a retryable attempt re-enters admit+gate, per the
 * durable state machine — `markFailed` returns the item to `queued`).
 */
import type { AttemptOutcome, ErrorClass, ItemRow } from "../journal/types";
import { registryPlugin } from "../registry";
import { canonicalJson, sha256Hex } from "./keys";
import { normalizeResult, OCTET_STREAM, resolveReferences } from "./resolve";
import { backoffMs, classifyError, isRetryableErrorClass, retryAfterMsOf } from "./retry";
import type {
  ActiveRun,
  DrainController,
  ExecutableHandler,
  HandlerRequest,
  HandlerResult,
  PlannedItem,
  ResolvedFile,
  RunEvent,
  RunnerContext
} from "./types";

/** Discriminated outcome of a single provider attempt. */
type AttemptOutcomeResult =
  | { kind: "done"; costUsd: number; contentHash: string }
  | { kind: "aborted" }
  | { kind: "flagged" }
  | { kind: "terminal-failed"; errorClass: ErrorClass }
  | { kind: "retryable"; errorClass: ErrorClass; retryAfterMs: number | undefined };

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
  const candidate = value as {
    estimate?: unknown;
    execute?: unknown;
    submit?: unknown;
    poll?: unknown;
  };
  if (typeof candidate.estimate !== "function") return false;
  if (typeof candidate.execute === "function") return true;
  return typeof candidate.submit === "function" && typeof candidate.poll === "function";
}

/**
 * Whether a handler runs provider-side jobs (`submit` + `poll`). Such
 * handlers are always driven through the job path, even when they also
 * expose `execute`, so the job id is journaled before any wait.
 *
 * @param handler - A narrowed handler.
 * @returns True when both `submit` and `poll` exist.
 * @example
 * ```ts
 * if (isJobHandler(handler)) await runJob(...);
 * ```
 */
function isJobHandler(
  handler: ExecutableHandler
): handler is ExecutableHandler & Required<Pick<ExecutableHandler, "submit" | "poll">> {
  return typeof handler.submit === "function" && typeof handler.poll === "function";
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
      `[ai] No executable handler registered for "${task}/${provider}".\n  Call registry.register("${task}", "${provider}", handler) with an object exposing estimate() plus execute() or submit()/poll().`
    );
  }
  return handler;
}

/**
 * Legacy artifact identity key from a planning key, provider and pack
 * version — only for item rows written before artifact keys were planned
 * (the planner now writes the key at insert; see plan.ts).
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
 * Builds the error a timed-out provider job raises: classified `timeout`
 * (retryable), after the job is marked `expired`. The next attempt adopts
 * the expired job and polls it before it submits a new one.
 *
 * @param jobTimeoutMs - The configured job timeout, ms.
 * @returns The error to throw.
 * @example
 * ```ts
 * throw jobTimeoutError(1_800_000);
 * ```
 */
function jobTimeoutError(jobTimeoutMs: number): Error {
  return Object.assign(
    new Error(
      `[ai] Provider job did not finish within ${Math.round(jobTimeoutMs / 1000)} s.\n  It is marked expired; the next attempt polls it again before submitting a new one.`
    ),
    { kind: "timeout" as const }
  );
}

/**
 * The error thrown when the drain signal stops a job wait — the caller
 * turns it into an `aborted` attempt and leaves the item `dispatching`.
 *
 * @param signal - The aborted drain signal.
 * @returns The signal's reason, or a plain abort error.
 * @example
 * ```ts
 * throw abortReasonOf(signal);
 * ```
 */
function abortReasonOf(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("[ai] Aborted.\n  The run was paused.");
}

/** A job handler: exposes `submit` + `poll`. */
type JobHandler = ExecutableHandler & Required<Pick<ExecutableHandler, "submit" | "poll">>;

/**
 * The job an attempt drives: its provider id and, when it was adopted after
 * a runner stopped waiting for it, the attempt row it was adopted from.
 */
type StartedJob = { jobId: string; adoptedFrom: number | undefined };

/**
 * Starts or adopts the provider job for an item: a live job with the same
 * artifact key (from any run, e.g. after a crash, a pause or a job timeout)
 * is adopted and polled; otherwise the handler submits a new one. The job id
 * is journaled on the attempt before anything waits on it.
 *
 * @param ctx - Runner domain context.
 * @param item - The dispatching item.
 * @param handler - A job handler (`submit` + `poll`).
 * @param request - The resolved request.
 * @param attemptId - The current attempt row.
 * @param signal - Drain signal.
 * @returns The job id, and the source attempt when an expired job was adopted.
 * @example
 * ```ts
 * const job = await startJob(ctx, item, handler, request, attemptId, signal);
 * ```
 */
async function startJob(
  ctx: RunnerContext,
  item: ItemRow,
  handler: JobHandler,
  request: HandlerRequest,
  attemptId: number,
  signal: AbortSignal
): Promise<StartedJob> {
  const live = item.artifactKey === null ? undefined : ctx.journal.findLiveJob(item.artifactKey);
  if (live) {
    ctx.journal.setAttemptJob(attemptId, { externalId: live.externalId, jobState: "submitted" });
    const isExpired = live.jobState === "expired";
    ctx.log.info(isExpired ? "runner:job:adopted-expired" : "runner:job:adopted", {
      itemId: item.id
    });
    return { jobId: live.externalId, adoptedFrom: isExpired ? live.attemptId : undefined };
  }

  return {
    jobId: await submitJob(ctx, item, handler, request, attemptId, signal),
    adoptedFrom: undefined
  };
}

/**
 * Submits a new provider job and journals its id on the attempt.
 *
 * @param ctx - Runner domain context.
 * @param item - The dispatching item.
 * @param handler - A job handler.
 * @param request - The resolved request.
 * @param attemptId - The current attempt row.
 * @param signal - Drain signal.
 * @returns The new job id.
 * @example
 * ```ts
 * const jobId = await submitJob(ctx, item, handler, request, attemptId, signal);
 * ```
 */
async function submitJob(
  ctx: RunnerContext,
  item: ItemRow,
  handler: JobHandler,
  request: HandlerRequest,
  attemptId: number,
  signal: AbortSignal
): Promise<string> {
  const { jobId } = await handler.submit(request, { signal });
  ctx.journal.setAttemptJob(attemptId, { externalId: jobId, jobState: "submitted" });
  ctx.log.info("runner:job:submitted", { itemId: item.id });
  return jobId;
}

/**
 * First poll of a job adopted after it expired. When the provider reports it
 * failed, or does not know it (a thrown 4xx), the job is lost: the source
 * attempt and this attempt are marked `failed` and a new job is submitted in
 * this attempt. A content-policy verdict, pending and done are returned for
 * the normal loop; an abort or an unclassified error is rethrown.
 *
 * @param ctx - Runner domain context.
 * @param item - The dispatching item.
 * @param handler - A job handler.
 * @param job - The adopted job.
 * @param job.jobId - Its provider job id.
 * @param job.adoptedFrom - The attempt row it was adopted from.
 * @param request - The resolved request.
 * @param attemptId - The current attempt row.
 * @param signal - Drain signal.
 * @returns The first poll, or a pending poll for the newly submitted job.
 * @example
 * ```ts
 * const first = await pollAdoptedExpired(ctx, item, handler, job, request, attemptId, signal);
 * ```
 */
async function pollAdoptedExpired(
  ctx: RunnerContext,
  item: ItemRow,
  handler: JobHandler,
  job: { jobId: string; adoptedFrom: number },
  request: HandlerRequest,
  attemptId: number,
  signal: AbortSignal
): Promise<{ poll: Awaited<ReturnType<JobHandler["poll"]>>; jobId: string }> {
  let poll: Awaited<ReturnType<JobHandler["poll"]>>;
  try {
    poll = await pollOnce(ctx, handler, job.jobId, request, attemptId, signal);
  } catch (error) {
    // An abort pauses; an unclassified error is a bug, never a reason to pay for a new job.
    if (signal.aborted || classifyError(error) === "unknown") throw error;
    poll = { state: "failed", error };
  }

  // A content-policy verdict ends the item as flagged: the same prompt would be flagged again.
  const isFlagged = poll.state === "failed" && classifyError(poll.error) === "content-policy";
  if (poll.state !== "failed" || isFlagged) return { poll, jobId: job.jobId };

  // The provider lost or failed the expired job: only now is a second job paid for.
  // Both rows are marked failed, so findLiveJob never returns the lost job again.
  ctx.journal.setAttemptJob(job.adoptedFrom, { jobState: "failed" });
  ctx.journal.setAttemptJob(attemptId, { jobState: "failed" });
  if (signal.aborted) throw abortReasonOf(signal);
  ctx.log.warn("runner:job:resubmitted", { itemId: item.id });
  const jobId = await submitJob(ctx, item, handler, request, attemptId, signal);
  return { poll: { state: "pending" }, jobId };
}

/**
 * Drives one provider job to an end state (D8): start or adopt it, then poll
 * every `pollIntervalMs`. A retryable poll failure (a transport problem) keeps
 * polling; a job the provider finished with an error, or a terminal poll
 * failure, marks the job `failed` and throws; a job still pending after
 * `jobTimeoutMs` is marked `expired` and throws a retryable timeout. A job
 * adopted after it expired is polled first and re-submitted only when the
 * provider lost or failed it. An abort leaves the job `submitted`, so resume
 * or a later run adopts it.
 *
 * @param ctx - Runner domain context.
 * @param item - The dispatching item.
 * @param handler - A job handler (`submit` + `poll`).
 * @param request - The resolved request.
 * @param attemptId - The current attempt row.
 * @param signal - Drain signal.
 * @returns The finished job's result.
 * @example
 * ```ts
 * const result = await runJob(ctx, item, handler, request, attemptId, signal);
 * ```
 */
async function runJob(
  ctx: RunnerContext,
  item: ItemRow,
  handler: JobHandler,
  request: HandlerRequest,
  attemptId: number,
  signal: AbortSignal
): Promise<HandlerResult> {
  let deadline = Date.now() + ctx.config.jobTimeoutMs;
  const job = await startJob(ctx, item, handler, request, attemptId, signal);
  let jobId = job.jobId;
  let adoptedFrom = job.adoptedFrom;

  for (;;) {
    // Stop cleanly when the drain signal fired since the last poll.
    if (signal.aborted) throw abortReasonOf(signal);

    // Poll the job; an expired one adopted this attempt gets its first-poll verdict instead.
    let poll: Awaited<ReturnType<JobHandler["poll"]>>;
    if (adoptedFrom === undefined) {
      poll = await pollOnce(ctx, handler, jobId, request, attemptId, signal);
    } else {
      const first = await pollAdoptedExpired(
        ctx,
        item,
        handler,
        { jobId, adoptedFrom },
        request,
        attemptId,
        signal
      );
      // A job submitted in place of a lost one gets its own full timeout.
      if (first.jobId !== jobId) deadline = Date.now() + ctx.config.jobTimeoutMs;
      ({ poll, jobId } = first);
      adoptedFrom = undefined;
    }

    // A done or failed job ends the loop.
    if (poll.state === "done") {
      ctx.journal.setAttemptJob(attemptId, { jobState: "done" });
      return poll;
    }
    if (poll.state === "failed") {
      ctx.journal.setAttemptJob(attemptId, { jobState: "failed" });
      throw poll.error;
    }

    // Still pending: expire at the deadline, else wait for the next poll.
    if (Date.now() >= deadline) {
      ctx.journal.setAttemptJob(attemptId, { jobState: "expired" });
      throw jobTimeoutError(ctx.config.jobTimeoutMs);
    }
    await delay(ctx.config.pollIntervalMs, signal);
  }
}

/**
 * One poll of a provider job. A thrown retryable error (transport problem)
 * reads as `pending`; a classified non-retryable error marks the job `failed`
 * and is rethrown. An abort, or an unclassified error (a bug, not the
 * provider's verdict), is rethrown with the job left `submitted`, so a later
 * attempt or run adopts it instead of paying for a new one.
 *
 * @param ctx - Runner domain context.
 * @param handler - A job handler.
 * @param jobId - The provider job id.
 * @param request - The resolved request.
 * @param attemptId - The current attempt row.
 * @param signal - Drain signal.
 * @returns The poll result.
 * @example
 * ```ts
 * const poll = await pollOnce(ctx, handler, jobId, request, attemptId, signal);
 * ```
 */
async function pollOnce(
  ctx: RunnerContext,
  handler: JobHandler,
  jobId: string,
  request: HandlerRequest,
  attemptId: number,
  signal: AbortSignal
): ReturnType<typeof handler.poll> {
  try {
    return await handler.poll(jobId, request, { signal });
  } catch (error) {
    if (signal.aborted) throw error;

    const errorClass = classifyError(error);
    if (!isRetryableErrorClass(errorClass)) {
      // An unclassified error is a bug on our side, not the provider's verdict: the job stays adoptable.
      if (errorClass !== "unknown") ctx.journal.setAttemptJob(attemptId, { jobState: "failed" });
      throw error;
    }
    ctx.log.warn("runner:job:poll-retry", { errorClass });
    return { state: "pending" };
  }
}

/**
 * Runs one provider attempt for an item already gated to `dispatching`:
 * records the attempt, runs the handler (the job path for `submit` + `poll`
 * handlers, else `execute`), normalizes the result, and persists the
 * artifact (`store.put` → `journal.commitDone` with its mime type). On
 * failure, classifies and transitions via {@link handleAttemptError}; when
 * the drain signal aborted, ends the attempt `aborted` and leaves the item
 * `dispatching` for resume.
 *
 * @param ctx - Runner domain context.
 * @param item - The item, already `dispatching`.
 * @param request - The resolved request (never journaled).
 * @param signal - Drain signal, forwarded to the handler.
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
    const result = await runHandler(ctx, item, handler, request, attemptId, signal);
    const { bytes, mimeType } = normalizeResult(result);
    ctx.journal.finishAttempt(attemptId, {
      endedAt: Date.now(),
      outcome: "done",
      costUsd: result.costUsd
    });
    ctx.limits.reportOutcome(lane, "ok");

    const putResult = await ctx.store.put(bytes);
    ctx.journal.commitDone(item.id, {
      actualCostUsd: result.costUsd,
      artifactKey:
        item.artifactKey ?? artifactKeyOf(item.planningKey, item.provider, item.packVersion),
      contentHash: putResult.hash,
      mimeType
    });
    return { kind: "done", costUsd: result.costUsd, contentHash: putResult.hash };
  } catch (error) {
    // The drain's own abort (no provider hint) pauses; a real provider error still counts.
    if (signal.aborted && classifyError(error) === "unknown") {
      ctx.journal.finishAttempt(attemptId, { endedAt: Date.now(), outcome: "aborted" });
      return { kind: "aborted" };
    }
    return handleAttemptError(ctx, item, lane, attemptId, error);
  }
}

/**
 * Calls the handler the way its shape asks for: the job path for `submit` +
 * `poll`, else `execute`.
 *
 * @param ctx - Runner domain context.
 * @param item - The dispatching item.
 * @param handler - The narrowed handler.
 * @param request - The resolved request.
 * @param attemptId - The current attempt row.
 * @param signal - Drain signal.
 * @returns The handler's result.
 * @throws {Error} When the handler exposes neither form (guarded earlier; defensive).
 * @example
 * ```ts
 * const result = await runHandler(ctx, item, handler, request, attemptId, signal);
 * ```
 */
async function runHandler(
  ctx: RunnerContext,
  item: ItemRow,
  handler: ExecutableHandler,
  request: HandlerRequest,
  attemptId: number,
  signal: AbortSignal
): Promise<HandlerResult> {
  if (isJobHandler(handler)) return runJob(ctx, item, handler, request, attemptId, signal);
  if (handler.execute) return handler.execute(request, { signal });
  throw new Error(
    `[ai] Handler "${item.task}/${item.provider}" cannot execute.\n  Expose execute() or submit()/poll().`
  );
}

/** Sentinel returned by {@link applyOutcome}: `true` means the item reached a terminal state. */
type OutcomeApplied = { terminal: true } | { terminal: false; attempt: number; waitMs: number };

/**
 * Applies one attempt's outcome: reports the matching stream event for a
 * terminal outcome (`done`/`flagged`/`terminal-failed`), stops quietly on
 * `aborted` (the item stays `dispatching` for resume), or — for a
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
  if (outcome.kind === "aborted") return { terminal: true };
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
async function tryReuse(
  ctx: RunnerContext,
  item: ItemRow,
  report: (event: RunEvent) => void
): Promise<boolean> {
  if (item.artifactKey === null) return false;

  const artifact = ctx.journal.findDoneArtifact(item.artifactKey);
  if (!artifact || !(await ctx.store.has(artifact.contentHash))) return false;

  ctx.journal.reuseDone(item.id, artifact);
  ctx.log.info("runner:reused", { itemId: item.id });
  report({ type: "item:done", itemId: item.id, costUsd: 0, contentHash: artifact.contentHash });
  return true;
}

/**
 * Resolves an item's `$ref` targets to their stored artifacts (D10). Every
 * target must be `done` in this run; otherwise the item is blocked.
 *
 * @param ctx - Runner domain context.
 * @param item - The queued item.
 * @param plan - The item's plan (target id → planning key).
 * @returns Resolved files by target id, or undefined when a target is not done.
 * @example
 * ```ts
 * const refFiles = resolveReferenceFiles(ctx, item, plan);
 * ```
 */
function resolveReferenceFiles(
  ctx: RunnerContext,
  item: ItemRow,
  plan: PlannedItem
): Map<string, ResolvedFile> | undefined {
  const refFiles = new Map<string, ResolvedFile>();

  for (const [targetId, planningKey] of plan.refKeys) {
    const target = ctx.journal.getItem(item.runId, planningKey);
    if (target?.status !== "done" || target.contentHash === null) {
      ctx.log.warn("runner:blocked", { itemId: item.id, waitingFor: targetId });
      return undefined;
    }
    refFiles.set(targetId, {
      path: ctx.store.pathOf(target.contentHash),
      mimeType: target.mimeType ?? OCTET_STREAM,
      hash: target.contentHash
    });
  }

  return refFiles;
}

/** How {@link executeItem} ended for an item that did not reach a provider outcome. */
export type ItemSettlement = "settled" | "blocked";

/**
 * Drives one item through the durable pipeline to a terminal outcome:
 * reuse(journal, D2) → wait for `$ref` targets (D10) → resolve references →
 * admit(limits.acquire) → gate(journal.gateToDispatching, atomic) → execute
 * or submit+poll → persist → report, looping on retryable failures (each
 * retry re-enters admit+gate, since `markFailed` returns the item to
 * `queued`) until it reaches `done`/`failed`/`flagged`, exhausts
 * `maxAttempts`, or the drain signal aborts (leaving it `queued`, or
 * `dispatching` when a job was in flight, for a future resume). Reports every
 * transition via `report`, including the initial `item:queued` marker.
 *
 * @param ctx - Runner domain context.
 * @param item - The queued item row to execute.
 * @param plan - The item's plan (request, maxAttempts, references).
 * @param drain - The run's drain controller (abort + budget-stop signal).
 * @param active - The active run's live bookkeeping (in-flight counter).
 * @param report - Callback invoked with every per-item stream record.
 * @param dependencies - Settles once every `$ref` target of this item has settled.
 * @returns `"blocked"` when a `$ref` target did not finish `done`, else `"settled"`.
 * @example
 * ```ts
 * await executeItem(ctx, item, plan, drain, active, report, Promise.resolve());
 * ```
 */
export async function executeItem(
  ctx: RunnerContext,
  item: ItemRow,
  plan: PlannedItem,
  drain: DrainController,
  active: ActiveRun,
  report: (event: RunEvent) => void,
  dependencies: Promise<unknown>
): Promise<ItemSettlement> {
  report({ type: "item:queued", itemId: item.id, task: item.task, provider: item.provider });
  if (await tryReuse(ctx, item, report)) return "settled";

  // $ref targets first; a target that did not finish done blocks this item.
  await dependencies;
  if (drain.signal.aborted) return "settled";
  const refFiles = resolveReferenceFiles(ctx, item, plan);
  if (!refFiles) return "blocked";
  const request = resolveReferences(plan.request, refFiles, plan.files) as HandlerRequest;

  let attempt = item.attemptCount;
  while (!drain.signal.aborted) {
    active.inFlight += 1;
    try {
      const lane = laneOf(item);
      const admission = await acquireLane(ctx, lane, drain.signal);
      if (!admission) return "settled";

      try {
        const gate = ctx.journal.gateToDispatching(item.id);
        if (!gate.ok) {
          if (gate.reason === "budget") drain.triggerBudgetStop();
          return "settled";
        }
        report({ type: "item:dispatching", itemId: item.id });

        const outcome = await attemptOnce(ctx, item, request, drain.signal);
        const applied = applyOutcome(ctx, item, plan.maxAttempts, attempt, outcome, report);
        if (applied.terminal) return "settled";

        attempt = applied.attempt;
        await delay(applied.waitMs, drain.signal);
      } finally {
        admission.release();
      }
    } finally {
      active.inFlight -= 1;
    }
  }
  return "settled";
}
