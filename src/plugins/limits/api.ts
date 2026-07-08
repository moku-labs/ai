/**
 * @file limits core plugin — API factory (`ctx.limits.*`).
 *
 * Async admission-control orchestration (waiting for tokens/concurrency
 * slots, abort handling) built on the pure, timer-free lane math in
 * `state.ts`. The only timers used here are one-shot, self-clearing
 * `setTimeout` calls scheduled for an exact computed deadline (never a
 * recurring interval), so the plugin still needs no `onStart`/`onStop`.
 */
import {
  breakerPhase,
  getOrCreateLane,
  peekLane,
  recordOutcome,
  refillTokens,
  refundToken,
  reserveToken
} from "./state";
import type { Config, LaneConfig, LaneSnapshot, LimitsApi, State } from "./types";

/**
 * Merges defaults with prefix (`"task/provider"`) and exact lane overrides.
 * Exact overrides win over prefix overrides, which win over defaults.
 *
 * @param lane - Lane key (`"{task}/{provider}/{account}"`).
 * @param config - Resolved limits configuration.
 * @returns The effective settings for `lane`.
 * @example
 * ```ts
 * resolveLaneConfig("voiceover/elevenlabs/default", config);
 * ```
 */
function resolveLaneConfig(lane: string, config: Readonly<Config>): LaneConfig {
  const [task, provider] = lane.split("/");
  const prefixKey =
    task !== undefined && provider !== undefined ? `${task}/${provider}` : undefined;
  const prefixOverride = prefixKey === undefined ? undefined : config.lanes[prefixKey];
  const exactOverride = config.lanes[lane];
  return { ...config.defaults, ...prefixOverride, ...exactOverride };
}

/**
 * Builds the immediate-rejection error for an open breaker. Kept as a plain
 * `Error` (per the project's error-format convention) with a `reason` tag
 * callers can branch on without string-matching the message.
 *
 * @param lane - Lane key the breaker is open for.
 * @returns A two-line-formatted error tagged with `reason: "breaker-open"`.
 * @example
 * ```ts
 * throw breakerOpenError("voiceover/elevenlabs/default");
 * ```
 */
function breakerOpenError(lane: string): Error & { reason: "breaker-open" } {
  const error = new Error(
    `[ai] limits: breaker open for lane "${lane}".\n  Wait for the cooldown to elapse, or retry against a different lane.`
  );
  return Object.assign(error, { reason: "breaker-open" as const });
}

/**
 * Resolves the rejection reason for an aborted wait: the signal's own
 * `reason` if the caller supplied one, otherwise a default two-line error.
 *
 * @param signal - The `AbortSignal` that fired.
 * @returns The value to reject the pending wait with.
 * @example
 * ```ts
 * reject(abortReason(signal));
 * ```
 */
function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new Error(
      "[ai] limits: acquire aborted while waiting for capacity.\n  No capacity was consumed; retry when ready."
    )
  );
}

/**
 * Waits `ms` milliseconds (via a single self-clearing timeout), rejecting
 * early and cleanly if `signal` aborts first.
 *
 * @param ms - Delay in milliseconds; resolves immediately if `<= 0`.
 * @param signal - Optional abort signal for a clean-cancel path.
 * @returns A promise settled after the delay or on abort.
 * @example
 * ```ts
 * await waitFor(1_000, opts?.signal);
 * ```
 */
function waitFor(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    /**
     * Clears the pending timeout and detaches the abort listener.
     *
     * @example
     * ```ts
     * cleanup();
     * ```
     */
    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    /**
     * Cancels the wait and rejects with the abort reason.
     *
     * @example
     * ```ts
     * signal.addEventListener("abort", onAbort);
     * ```
     */
    function onAbort(): void {
      cleanup();
      reject(abortReason(signal as AbortSignal));
    }

    signal?.addEventListener("abort", onAbort);
  });
}

/**
 * Queues the caller as a FIFO concurrency waiter, resolving when `release()`
 * hands it a slot. Removes itself from the queue on abort, so an aborted
 * wait never leaks a slot to a stale waiter.
 *
 * @param waiters - The lane's waiter queue (mutated in place).
 * @param signal - Optional abort signal for a clean-cancel path.
 * @returns A promise settled once a slot is granted or the wait aborts.
 * @example
 * ```ts
 * await waitForSlot(laneState.waiters, opts?.signal);
 * ```
 */
function waitForSlot(waiters: Array<() => void>, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }

    /**
     * Resolves this waiter once a concurrency slot is handed to it.
     *
     * @example
     * ```ts
     * waiters.shift()?.();
     * ```
     */
    const waiter = (): void => {
      cleanup();
      resolve();
    };

    /**
     * Detaches the abort listener and removes this waiter from the queue.
     *
     * @example
     * ```ts
     * cleanup();
     * ```
     */
    function cleanup(): void {
      signal?.removeEventListener("abort", onAbort);
      const index = waiters.indexOf(waiter);
      if (index !== -1) waiters.splice(index, 1);
    }
    /**
     * Cancels the wait and rejects with the abort reason.
     *
     * @example
     * ```ts
     * signal.addEventListener("abort", onAbort);
     * ```
     */
    function onAbort(): void {
      cleanup();
      reject(abortReason(signal as AbortSignal));
    }

    signal?.addEventListener("abort", onAbort);
    waiters.push(waiter);
  });
}

/**
 * Creates the limits API surface (`ctx.limits.*`): per-lane admission
 * control (token bucket + concurrency gate + circuit breaker) and
 * introspection.
 *
 * @param ctx - Core plugin context (config + state).
 * @param ctx.config - Resolved limits configuration.
 * @param ctx.state - Limits state (per-lane buckets).
 * @returns The `ctx.limits` API.
 * @example
 * ```ts
 * const api = createLimitsApi({ config, state });
 * const { release } = await api.acquire("voiceover/elevenlabs/default");
 * release();
 * ```
 */
export function createLimitsApi(ctx: {
  readonly config: Readonly<Config>;
  readonly state: State;
}): LimitsApi {
  /**
   * Effective settings for `lane`: defaults merged with prefix and exact
   * overrides.
   *
   * @param lane - Lane key.
   * @returns The lane's effective settings.
   * @example
   * ```ts
   * laneConfig("voiceover/elevenlabs/default");
   * ```
   */
  const laneConfig = (lane: string): LaneConfig => resolveLaneConfig(lane, ctx.config);

  /**
   * Waits for lane capacity (breaker closed/half-open, a token, and a
   * concurrency slot) then grants it.
   *
   * @param lane - Lane key to acquire capacity on.
   * @param opts - Optional acquire options.
   * @param opts.signal - Abort signal for a clean-cancel wait.
   * @returns A handle whose `release()` must be called exactly once.
   * @example
   * ```ts
   * const { release } = await acquire("voiceover/elevenlabs/default");
   * release();
   * ```
   */
  async function acquire(
    lane: string,
    opts?: { signal?: AbortSignal }
  ): Promise<{ release: () => void }> {
    const config = laneConfig(lane);
    const laneState = getOrCreateLane(ctx.state, lane, config, Date.now());

    // Breaker gate: open rejects everyone; half-open admits exactly ONE
    // trial probe (claimed synchronously here, settled by reportOutcome).
    const phase = breakerPhase(laneState, Date.now());
    if (phase === "open" || (phase === "half-open" && laneState.probing)) {
      throw breakerOpenError(lane);
    }
    const isProbe = phase === "half-open";
    if (isProbe) laneState.probing = true;

    /**
     * Releases the half-open probe claim on an abandoned (aborted) wait so
     * the lane is not locked out of probing forever.
     *
     * @example
     * ```ts
     * releaseProbeClaim();
     * ```
     */
    const releaseProbeClaim = (): void => {
      if (isProbe) laneState.probing = false;
    };

    const waitMs = reserveToken(laneState, config, Date.now());
    try {
      await waitFor(waitMs, opts?.signal);
    } catch (error) {
      refundToken(laneState);
      releaseProbeClaim();
      throw error;
    }

    if (laneState.inFlight >= config.concurrency) {
      try {
        await waitForSlot(laneState.waiters, opts?.signal);
      } catch (error) {
        refundToken(laneState);
        releaseProbeClaim();
        throw error;
      }
    }

    laneState.inFlight += 1;
    let released = false;
    return {
      /**
       * Releases the held concurrency slot; a no-op after the first call.
       *
       * @example
       * ```ts
       * release();
       * ```
       */
      release: () => {
        if (released) return;
        released = true;
        laneState.inFlight -= 1;
        const next = laneState.waiters.shift();
        next?.();
      }
    };
  }

  /**
   * Feeds the breaker with a request outcome.
   *
   * @param lane - Lane key the outcome applies to.
   * @param outcome - `"ok"` closes/resets the breaker; `"retryable-error"` advances it toward open.
   * @example
   * ```ts
   * reportOutcome("voiceover/elevenlabs/default", "ok");
   * ```
   */
  function reportOutcome(lane: string, outcome: "ok" | "retryable-error"): void {
    const config = laneConfig(lane);
    const laneState = getOrCreateLane(ctx.state, lane, config, Date.now());
    recordOutcome(laneState, config, outcome, Date.now());
  }

  /**
   * Introspection snapshot for `lane`, for `moku status`.
   *
   * @param lane - Lane key to inspect.
   * @returns The lane's current tokens, in-flight count, waiting count, and breaker phase.
   * @example
   * ```ts
   * snapshot("voiceover/elevenlabs/default");
   * ```
   */
  function snapshot(lane: string): LaneSnapshot {
    const config = laneConfig(lane);
    const laneState = peekLane(ctx.state, lane);
    if (!laneState) {
      return { lane, tokens: config.rpm, inFlight: 0, waiting: 0, breaker: "closed" };
    }

    refillTokens(laneState, config, Date.now());
    return {
      lane,
      tokens: laneState.tokens,
      inFlight: laneState.inFlight,
      waiting: laneState.waiters.length,
      breaker: breakerPhase(laneState, Date.now())
    };
  }

  /**
   * All lane keys currently tracked.
   *
   * @returns The tracked lane keys.
   * @example
   * ```ts
   * lanes(); // => ["voiceover/elevenlabs/default"]
   * ```
   */
  function lanes(): string[] {
    return [...ctx.state.lanes.keys()];
  }

  return { acquire, reportOutcome, laneConfig, snapshot, lanes };
}
