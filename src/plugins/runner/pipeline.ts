/**
 * @file runner pipeline — per-item execution: claim(artifact key) →
 * admit(limits) → gate(journal, atomic) → execute(handler) →
 * persist(store+journal) → report. Owns the runner's single audited dynamic
 * boundary (`isExecutableHandler`) and the per-item retry loop: a retryable
 * attempt re-enters admit+gate, per the durable state machine (`markFailed`
 * returns the item to `queued`). The cross-run dedupe claim lives in claim.ts.
 */
import type { AttemptOutcome, DoneOutput, ErrorClass, ItemRow } from "../journal/types";
import { registryPlugin } from "../registry";
import { claimArtifact, OPEN_VERDICT, tryReuse } from "./claim";
import { failureMessageOf, itemFailureOf, reportItemFailed } from "./failure";
import { canonicalJson, sha256Hex } from "./keys";
import { normalizeOutputs, normalizeResult, OCTET_STREAM, resolveReferences } from "./resolve";
import {
  backoffMs,
  classifyError,
  isOwnSideErrorClass,
  isResubmitVerdict,
  isRetryableErrorClass,
  retryAfterMsOf
} from "./retry";
import type {
  ClaimVerdict,
  DrainController,
  ExecutableHandler,
  HandlerRequest,
  HandlerResult,
  ItemFailure,
  PlannedItem,
  ResolvedFile,
  RunnerContext,
  UnstampedRunEvent
} from "./types";

/**
 * Discriminated outcome of a single provider attempt. A failed attempt
 * carries its {@link ItemFailure}: the class, plus the safe message (the
 * handler's `publicMessage` or our own `[ai]` text) when there is one, so a
 * retryable failure that exhausts the attempts still reports the last
 * attempt's message. A done attempt of a multi-output item carries every
 * output hash, in order, in `contentHashes`.
 */
type AttemptOutcomeResult =
  | { kind: "done"; costUsd: number; contentHash: string; contentHashes?: string[] }
  | { kind: "aborted" }
  | { kind: "flagged" }
  | ({ kind: "terminal-failed" } & ItemFailure)
  | ({ kind: "retryable"; retryAfterMs: number | undefined } & ItemFailure);

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
 * What {@link acquireLane} got: the lane slot, `"breaker-open"` when the
 * lane's breaker refused it, or `undefined` when the drain aborted the wait.
 */
type LaneAdmission = { release: () => void } | "breaker-open" | undefined;

/**
 * Waits for lane capacity. An aborted wait comes back as `undefined` and an
 * open breaker as `"breaker-open"`, so the caller can wait out the cooldown
 * and ask again. Any other rejection is a bug and is rethrown.
 *
 * @param ctx - Runner domain context.
 * @param lane - Lane key to acquire capacity on.
 * @param signal - Drain signal; aborts the wait cleanly.
 * @returns The release handle, `"breaker-open"`, or undefined when the wait was aborted.
 * @throws {Error} Any rejection that is neither an abort nor an open breaker.
 */
async function acquireLane(
  ctx: RunnerContext,
  lane: string,
  signal: AbortSignal
): Promise<LaneAdmission> {
  try {
    return await ctx.limits.acquire(lane, { signal });
  } catch (error) {
    // A pause ends the wait quietly; an open breaker is the caller's to wait out.
    if (signal.aborted) return undefined;
    const isBreakerOpen =
      typeof error === "object" &&
      error !== null &&
      "reason" in error &&
      error.reason === "breaker-open";
    if (isBreakerOpen) return "breaker-open";
    throw error;
  }
}

/**
 * Least time an item sleeps before it asks a refusing lane again, ms. A
 * `breakerCooldownMs` of 0 makes a tripped lane half-open at once: without
 * this floor every waiting item would ask again in a microtask loop and
 * starve the I/O of the probe it waits for. It is also the whole wait on a
 * half-open lane, where the probe in flight may close the breaker any moment.
 */
const LANE_OPEN_MIN_WAIT_MS = 250;

/**
 * How long an item sleeps after a lane refused it with `"breaker-open"`.
 * Only a lane still open waits the lane's `breakerCooldownMs` (never less than
 * {@link LANE_OPEN_MIN_WAIT_MS}). Half-open (a probe is in flight) or already
 * closed again waits just the floor, since the lane may admit the item soon.
 *
 * @param ctx - Runner domain context.
 * @param lane - The lane that refused the item.
 * @returns The wait before the item asks the lane again, ms.
 */
function laneOpenWaitMs(ctx: RunnerContext, lane: string): number {
  const isOpen = ctx.limits.snapshot(lane).breaker === "open";
  if (!isOpen) return LANE_OPEN_MIN_WAIT_MS;

  const cooldownMs = ctx.limits.laneConfig(lane).breakerCooldownMs;
  return Math.max(cooldownMs, LANE_OPEN_MIN_WAIT_MS);
}

/**
 * Resolves after `ms` milliseconds, or at once when `signal` is already
 * aborted or fires during the wait. The abort listener comes off the signal
 * when the timer fires, so poll ticks, backoffs and breaker cooldowns never
 * pile listeners onto the run-long drain signal.
 *
 * @param ms - Delay in milliseconds.
 * @param signal - Drain signal; aborts the wait cleanly.
 * @returns Resolves once the delay elapses or the signal aborts.
 * @example
 * ```ts
 * await delay(1_000, AbortSignal.abort()); // resolves at once: the signal is already aborted
 * ```
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();

  return new Promise(resolve => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Creates a drain controller merging an optional external abort signal with
 * an internal budget-stop trigger into one signal the pipeline can select on.
 *
 * @param externalSignal - The caller-supplied `opts.signal`, if any.
 * @returns A controller exposing the merged signal, a `budgetStopped` flag, and the trigger.
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
 * the retryable classes are `retryable-error`, everything else (`http-4xx`,
 * `invalid-request`, `local-failure`, `unknown`) is a `terminal-error`.
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
 * retryable failures. A provider's `kind: "resubmit"` verdict retries like
 * its status says but never feeds the lane breaker. A failed outcome carries
 * the error's safe message, its `publicMessage` or our own `[ai]` text
 * ({@link failureMessageOf}). The
 * retryable-vs-exhausted decision is left to the caller, which tracks the
 * cross-attempt count.
 *
 * @param ctx - Runner domain context.
 * @param item - The item the failed attempt belongs to.
 * @param lane - The item's lane key.
 * @param attemptId - The attempt row id, from `journal.recordAttempt`.
 * @param error - The error thrown by `handler.execute`.
 * @returns The attempt's outcome.
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
  const failure = itemFailureOf(errorClass, failureMessageOf(error));

  ctx.journal.finishAttempt(attemptId, { endedAt: Date.now(), outcome, errorClass });

  if (outcome === "flagged") {
    ctx.journal.markFlagged(item.id);
    return { kind: "flagged" };
  }
  if (outcome === "terminal-error") {
    ctx.journal.markFailed(item.id, { errorClass, terminal: true });
    return { kind: "terminal-failed", ...failure };
  }

  // Retryable: a lane failure feeds the breaker; a "submit again" verdict does not.
  const isLaneFailure = !isResubmitVerdict(error);
  if (isLaneFailure) ctx.limits.reportOutcome(lane, "retryable-error");
  return { kind: "retryable", ...failure, retryAfterMs: retryAfterMsOf(error) };
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
 * the normal loop; an abort or an error of our own side (`unknown`,
 * `invalid-request`, `local-failure`: {@link isOwnSideErrorClass}) is
 * rethrown.
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
    // An abort pauses; an error of our own side is never a reason to pay for a new job.
    if (signal.aborted || isOwnSideErrorClass(classifyError(error))) throw error;
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
 * failure the provider gave, marks the job `failed` and throws (a poll error
 * of our own side marks it `expired`, see {@link pollOnce}); a job still
 * pending after `jobTimeoutMs` is marked `expired` and throws a retryable
 * timeout. A job adopted after it expired is polled first and re-submitted
 * only when the provider lost or failed it. An abort leaves the job
 * `submitted`, so resume or a later run adopts it.
 *
 * @param ctx - Runner domain context.
 * @param item - The dispatching item.
 * @param handler - A job handler (`submit` + `poll`).
 * @param request - The resolved request.
 * @param attemptId - The current attempt row.
 * @param signal - Drain signal.
 * @returns The finished job's result.
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
 * reads as `pending`; a non-retryable error the provider gave (`http-4xx`,
 * `content-policy`) marks the job `failed` and is rethrown. An abort is
 * rethrown with the job left `submitted`. An error of our own side
 * (`unknown`, `invalid-request`, `local-failure`: not the provider's verdict)
 * marks the job `expired` and is rethrown: a later run adopts it instead of
 * paying for a new one, and after two expiries a new job is submitted.
 *
 * @param ctx - Runner domain context.
 * @param handler - A job handler.
 * @param jobId - The provider job id.
 * @param request - The resolved request.
 * @param attemptId - The current attempt row.
 * @param signal - Drain signal.
 * @returns The poll result.
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
      // An error of our own side is not the provider's verdict: the job is marked expired,
      // so it stays adoptable and the two-expiry cap still ends in one new submit.
      ctx.journal.setAttemptJob(attemptId, {
        jobState: isOwnSideErrorClass(errorClass) ? "expired" : "failed"
      });
      throw error;
    }
    ctx.log.warn("runner:job:poll-retry", { errorClass });
    return { state: "pending" };
  }
}

/** Bytes to store and their mime type: one artifact, or one output of a multi-image result. */
type ArtifactBytes = ReturnType<typeof normalizeResult>;

/**
 * Stores what a successful attempt produced, then moves the item to `done`:
 * the bytes are durable before the item is. A multi-image result stores
 * every output in order, its first output being the item's content hash and
 * mime type, and journals and reports all of them. That holds whenever the
 * handler returned `images`, even a group of one, so the caller sees the count.
 *
 * @param ctx - Runner domain context.
 * @param item - The dispatching item.
 * @param costUsd - The attempt's actual cost.
 * @param artifact - The item's (first) artifact.
 * @param outputs - Every output of a multi-image result, `artifact` first; undefined for a single artifact.
 * @returns The `done` outcome.
 */
async function commitArtifacts(
  ctx: RunnerContext,
  item: ItemRow,
  costUsd: number,
  artifact: ArtifactBytes,
  outputs: ArtifactBytes[] | undefined
): Promise<AttemptOutcomeResult> {
  // Store the first artifact, then every further output in order.
  const { hash } = await ctx.store.put(artifact.bytes);
  const stored: DoneOutput[] = [{ contentHash: hash, mimeType: artifact.mimeType }];
  for (const output of outputs?.slice(1) ?? []) {
    const put = await ctx.store.put(output.bytes);
    stored.push({ contentHash: put.hash, mimeType: output.mimeType });
  }

  // The item is done; a multi-output item also journals and reports every output.
  ctx.journal.commitDone(item.id, {
    actualCostUsd: costUsd,
    artifactKey:
      item.artifactKey ?? artifactKeyOf(item.planningKey, item.provider, item.packVersion),
    contentHash: hash,
    mimeType: artifact.mimeType,
    ...(outputs ? { outputs: stored } : {})
  });
  const contentHashes = stored.map(output => output.contentHash);
  return { kind: "done", costUsd, contentHash: hash, ...(outputs ? { contentHashes } : {}) };
}

/**
 * Runs one provider attempt for an item already gated to `dispatching`:
 * records the attempt, runs the handler (the job path for `submit` + `poll`
 * handlers, else `execute`), normalizes the result, and persists the
 * artifact, or every output of a multi-image result ({@link commitArtifacts}:
 * `store.put` → `journal.commitDone` with its mime type). On
 * failure, classifies and transitions via {@link handleAttemptError}; when
 * the drain signal aborted, ends the attempt `aborted` and leaves the item
 * `dispatching` for resume.
 *
 * @param ctx - Runner domain context.
 * @param item - The item, already `dispatching`.
 * @param request - The resolved request (never journaled).
 * @param signal - Drain signal, forwarded to the handler.
 * @returns The attempt's outcome.
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
    // Every image of a multi-image result, else the one artifact; no content at all throws here.
    const result = await runHandler(ctx, item, handler, request, attemptId, signal);
    const outputs = normalizeOutputs(result);
    const artifact = outputs?.[0] ?? normalizeResult(result);
    ctx.journal.finishAttempt(attemptId, {
      endedAt: Date.now(),
      outcome: "done",
      costUsd: result.costUsd
    });
    ctx.limits.reportOutcome(lane, "ok");

    return await commitArtifacts(ctx, item, result.costUsd, artifact, outputs);
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

/**
 * Result of {@link applyOutcome} and {@link dispatchAdmitted}: the item
 * stopped, with the verdict its artifact claim settles with, or it retries
 * as attempt `attempt` after `waitMs`.
 */
type AttemptStep = { verdict: ClaimVerdict } | { attempt: number; waitMs: number };

/**
 * Applies one attempt's outcome: reports the matching stream event for a
 * terminal outcome (`done`/`flagged`/`terminal-failed`), stops quietly on
 * `aborted` (the item stays `dispatching` for resume), or — for a
 * retryable outcome — either exhausts `maxAttempts` (terminal `failed`) or
 * transitions the item back to `queued` and reports `item:retry` with the
 * computed backoff delay. Every `item:failed` carries the item's label and
 * the attempt's safe message, if any (see {@link reportItemFailed}). A stop
 * carries the item's claim verdict: `done`, `flagged`, `failed` with its class
 * (and message) for a non-retryable failure, or `open`
 * for an abort and for retryable attempts exhausted: a 5xx, 429, network or
 * timeout error can pass on a later try, so a follower tries for itself.
 * Extracted to keep the {@link runAttempts} loop flat.
 *
 * @param ctx - Runner domain context.
 * @param item - The item the attempt belongs to.
 * @param maxAttempts - The effective per-item attempt ceiling.
 * @param attempt - The attempt count going into this outcome (before increment).
 * @param outcome - The attempt's outcome.
 * @param report - Callback invoked with the resulting stream event.
 * @returns The verdict when the item stops, or the next attempt count and backoff delay.
 */
function applyOutcome(
  ctx: RunnerContext,
  item: ItemRow,
  maxAttempts: number,
  attempt: number,
  outcome: AttemptOutcomeResult,
  report: (event: UnstampedRunEvent) => void
): AttemptStep {
  // Terminal outcomes: report the matching record and stop the item.
  if (outcome.kind === "aborted") return { verdict: OPEN_VERDICT };
  if (outcome.kind === "done") {
    report({
      type: "item:done",
      itemId: item.id,
      costUsd: outcome.costUsd,
      contentHash: outcome.contentHash,
      ...(outcome.contentHashes ? { contentHashes: outcome.contentHashes } : {})
    });
    return { verdict: { kind: "done" } };
  }
  if (outcome.kind === "flagged") {
    report({ type: "item:flagged", itemId: item.id });
    return { verdict: { kind: "flagged" } };
  }
  if (outcome.kind === "terminal-failed") {
    const failure = itemFailureOf(outcome.errorClass, outcome.message);
    reportItemFailed(ctx, item, failure, report);
    return { verdict: { kind: "failed", ...failure } };
  }

  // Retryable: out of attempts is a terminal failure with the last attempt's message, else re-queue with a backoff.
  const nextAttempt = attempt + 1;
  if (nextAttempt >= maxAttempts) {
    ctx.journal.markFailed(item.id, { errorClass: outcome.errorClass, terminal: true });
    reportItemFailed(ctx, item, itemFailureOf(outcome.errorClass, outcome.message), report);
    return { verdict: OPEN_VERDICT };
  }

  ctx.journal.markFailed(item.id, { errorClass: outcome.errorClass, terminal: false });
  report({
    type: "item:retry",
    itemId: item.id,
    errorClass: outcome.errorClass,
    attempt: nextAttempt
  });
  const waitMs = backoffMs(nextAttempt, ctx.config.retryBaseMs, outcome.retryAfterMs);
  return { attempt: nextAttempt, waitMs };
}

/**
 * Resolves an item's `$ref` targets to their stored artifacts (D10). Every
 * target must be `done` in this run; otherwise the item is blocked.
 *
 * @param ctx - Runner domain context.
 * @param item - The queued item.
 * @param plan - The item's plan (target id → planning key).
 * @returns Resolved files by target id, or undefined when a target is not done.
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

/**
 * One admitted attempt: gate(journal, atomic) → attempt → apply the outcome.
 * The lane slot is released in a `finally` before this returns, so the retry
 * backoff that may follow never holds it. A gate refusal stops the item
 * `open`; a `"budget"` refusal also triggers the run's budget stop.
 *
 * @param ctx - Runner domain context.
 * @param item - The queued item.
 * @param plan - The item's plan (maxAttempts).
 * @param request - The resolved request.
 * @param drain - The run's drain controller.
 * @param admission - The lane slot `limits.acquire` granted.
 * @param admission.release - Frees the lane slot; called once, in the `finally`.
 * @param attempt - The attempt count going into this attempt.
 * @param report - Stream callback.
 * @returns The verdict when the item stops, or the next attempt count and backoff delay.
 */
async function dispatchAdmitted(
  ctx: RunnerContext,
  item: ItemRow,
  plan: PlannedItem,
  request: HandlerRequest,
  drain: DrainController,
  admission: { release: () => void },
  attempt: number,
  report: (event: UnstampedRunEvent) => void
): Promise<AttemptStep> {
  try {
    // Gate: budget, dedup and the move to dispatching, in one transaction.
    const gate = ctx.journal.gateToDispatching(item.id);
    if (!gate.ok) {
      if (gate.reason === "budget") drain.triggerBudgetStop();
      return { verdict: OPEN_VERDICT };
    }
    report({ type: "item:dispatching", itemId: item.id });

    // Attempt, then turn its outcome into a stop or a retry.
    const outcome = await attemptOnce(ctx, item, request, drain.signal);
    return applyOutcome(ctx, item, plan.maxAttempts, attempt, outcome, report);
  } finally {
    admission.release();
  }
}

/**
 * The per-item attempt loop: admit(limits.acquire) → gate(journal, atomic) →
 * attempt → apply the outcome, looping on retryable failures until the item
 * stops. A lane breaker that refuses the item is waited out: the item logs
 * `runner:lane-open`, sleeps (see {@link laneOpenWaitMs}: the lane's
 * `breakerCooldownMs`, at least {@link LANE_OPEN_MIN_WAIT_MS}, or only that
 * floor while a half-open probe is in flight) and asks again, so it is never
 * left queued without a record. A slot granted after the drain fired is
 * released at once, with no gate and no provider call. The lane slot is
 * released before the retry backoff, and every retry re-acquires it.
 * Returns the verdict its artifact
 * claim settles with: `open` when it stopped without a final provider verdict
 * (gate refused, drained, aborted mid-attempt, retryable attempts exhausted).
 *
 * @param ctx - Runner domain context.
 * @param item - The queued item.
 * @param plan - The item's plan (maxAttempts).
 * @param request - The resolved request.
 * @param drain - The run's drain controller.
 * @param report - Stream callback.
 * @returns The item's claim verdict.
 */
async function runAttempts(
  ctx: RunnerContext,
  item: ItemRow,
  plan: PlannedItem,
  request: HandlerRequest,
  drain: DrainController,
  report: (event: UnstampedRunEvent) => void
): Promise<ClaimVerdict> {
  const lane = laneOf(item);
  let attempt = item.attemptCount;
  let isLaneOpenLogged = false;

  while (!drain.signal.aborted) {
    // Admit: a refusing breaker is waited out (warned once per wait), then the lane is asked again.
    const admission = await acquireLane(ctx, lane, drain.signal);
    if (admission === "breaker-open") {
      if (!isLaneOpenLogged) ctx.log.warn("runner:lane-open", { itemId: item.id, lane });
      isLaneOpenLogged = true;
      await delay(laneOpenWaitMs(ctx, lane), drain.signal);
      continue;
    }
    isLaneOpenLogged = false;
    if (!admission) return OPEN_VERDICT;

    // A slot granted after the run stopped goes straight back: a stopped run makes no paid call.
    if (drain.signal.aborted) {
      admission.release();
      return OPEN_VERDICT;
    }

    // Gate, attempt and outcome; the lane slot is free again once this returns.
    const step = await dispatchAdmitted(
      ctx,
      item,
      plan,
      request,
      drain,
      admission,
      attempt,
      report
    );
    if ("verdict" in step) return step.verdict;
    attempt = step.attempt;

    // The backoff sleeps with the lane slot released, so a long Retry-After
    // never keeps one of the lane's concurrency slots busy.
    await delay(step.waitMs, drain.signal);
  }
  return OPEN_VERDICT;
}

/** How {@link executeItem} ended for an item that did not reach a provider outcome. */
export type ItemSettlement = "settled" | "blocked";

/**
 * Drives one item through the durable pipeline to a terminal outcome:
 * reuse(journal, D2) → wait for `$ref` targets (D10) → resolve references →
 * claim the artifact key (cross-run dedupe: wait for, and copy, the verdict
 * of an item of another run that holds it) → admit(limits.acquire, an open
 * breaker waited out) → gate(journal.gateToDispatching, atomic) → execute or
 * submit+poll → persist → report, looping on retryable failures (each retry
 * re-enters admit+gate, since `markFailed` returns the item to `queued`)
 * until it reaches `done`/`failed`/`flagged`, exhausts `maxAttempts`, or the
 * drain signal aborts (leaving it `queued`, or `dispatching` when a job was
 * in flight, for a future resume). The claim is settled with the item's
 * verdict in a `finally`, so a thrown bug settles it `open`. Reports every
 * transition via `report`, including the initial `item:queued` marker.
 *
 * @param ctx - Runner domain context.
 * @param item - The queued item row to execute.
 * @param plan - The item's plan (request, maxAttempts, references).
 * @param drain - The run's drain controller (abort + budget-stop signal).
 * @param report - Callback invoked with every per-item stream record; the run stamps its runId.
 * @param dependencies - Settles once every `$ref` target of this item has settled.
 * @returns `"blocked"` when a `$ref` target did not finish `done`, else `"settled"`.
 * @throws {Error} A bug in the pipeline (no handler registered, an unexpected lane rejection). The run then stops its other items and fails once they settled (api.ts).
 */
export async function executeItem(
  ctx: RunnerContext,
  item: ItemRow,
  plan: PlannedItem,
  drain: DrainController,
  report: (event: UnstampedRunEvent) => void,
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

  // One item per artifact key reaches the provider, across every active run.
  const settleClaim = await claimArtifact(ctx, item, drain, report);
  if (!settleClaim) return "settled";

  // Attempts until the item stops; the claim settles with its verdict even when a bug throws.
  let verdict = OPEN_VERDICT;
  try {
    verdict = await runAttempts(ctx, item, plan, request, drain, report);
    return "settled";
  } finally {
    settleClaim(verdict);
  }
}
