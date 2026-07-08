/**
 * @file limits core plugin — lane state factory and pure token-bucket /
 * circuit-breaker math.
 *
 * Every time-dependent function here takes `now` (ms epoch) as an explicit
 * parameter instead of reading the wall clock itself, so callers can drive
 * it with a fake clock in unit tests. There are no timers anywhere in this
 * file — refill and breaker transitions are lazy math computed on demand.
 */
import type { LaneConfig, LaneState, State } from "./types";

/**
 * Creates initial limits state (no lanes tracked until first acquire/report).
 *
 * @returns Initial limits state.
 * @example
 * ```ts
 * const state = createLimitsState();
 * ```
 */
export function createLimitsState(): State {
  return { lanes: new Map() };
}

/**
 * Builds a fresh lane bucket: a full token bucket, no in-flight requests, an
 * empty waiter queue, and a closed breaker.
 *
 * @param config - Effective settings for this lane.
 * @param now - Current time (ms epoch), used as the initial refill timestamp.
 * @returns A newly initialized lane state.
 * @example
 * ```ts
 * createLaneState(config, Date.now());
 * ```
 */
function createLaneState(config: LaneConfig, now: number): LaneState {
  return {
    tokens: config.rpm,
    lastRefillAt: now,
    inFlight: 0,
    waiters: [],
    consecutiveFailures: 0,
    openUntil: 0,
    probing: false
  };
}

/**
 * Returns the tracked state for `lane`, lazily creating and registering it
 * on first use.
 *
 * @param state - Root limits state.
 * @param lane - Lane key (`"{task}/{provider}/{account}"`).
 * @param config - Effective settings for this lane.
 * @param now - Current time (ms epoch).
 * @returns The lane's mutable state.
 * @example
 * ```ts
 * const lane = getOrCreateLane(state, "voiceover/elevenlabs/default", cfg, Date.now());
 * ```
 */
export function getOrCreateLane(
  state: State,
  lane: string,
  config: LaneConfig,
  now: number
): LaneState {
  const existing = state.lanes.get(lane);
  if (existing) return existing;

  const created = createLaneState(config, now);
  state.lanes.set(lane, created);
  return created;
}

/**
 * Looks up a lane's tracked state without registering it, for read-only
 * introspection of lanes that have never been acquired.
 *
 * @param state - Root limits state.
 * @param lane - Lane key.
 * @returns The tracked lane state, or `undefined` if never touched.
 * @example
 * ```ts
 * peekLane(state, "voiceover/elevenlabs/default");
 * ```
 */
export function peekLane(state: State, lane: string): LaneState | undefined {
  return state.lanes.get(lane);
}

/**
 * Lazily refills the token bucket in place, based on elapsed time since the
 * last refill and the lane's requests-per-minute rate. Capped at `rpm`
 * (bucket capacity). A no-op if `now` has not advanced.
 *
 * @param lane - Lane state to refill (mutated in place).
 * @param config - Effective settings for this lane.
 * @param now - Current time (ms epoch).
 * @example
 * ```ts
 * refillTokens(lane, config, Date.now());
 * ```
 */
export function refillTokens(lane: LaneState, config: LaneConfig, now: number): void {
  if (now <= lane.lastRefillAt) return;

  const elapsedMs = now - lane.lastRefillAt;
  const refillRatePerMs = config.rpm / 60_000;
  lane.tokens = Math.min(config.rpm, lane.tokens + elapsedMs * refillRatePerMs);
  lane.lastRefillAt = now;
}

/**
 * Refills the bucket, then reserves one token by decrementing it (which may
 * go negative to represent a pending reservation to be paid off by future
 * refill).
 *
 * @param lane - Lane state to reserve against (mutated in place).
 * @param config - Effective settings for this lane.
 * @param now - Current time (ms epoch).
 * @returns Milliseconds the caller must wait before the reserved token is
 *   actually available; `0` if a token was immediately free.
 * @example
 * ```ts
 * reserveToken(lane, config, Date.now());
 * ```
 */
export function reserveToken(lane: LaneState, config: LaneConfig, now: number): number {
  refillTokens(lane, config, now);
  lane.tokens -= 1;
  if (lane.tokens >= 0) return 0;

  const refillRatePerMs = config.rpm / 60_000;
  return Math.abs(lane.tokens) / refillRatePerMs;
}

/**
 * Refunds a token previously reserved via {@link reserveToken}, used on the
 * clean-abort path where the reservation was never consumed.
 *
 * @param lane - Lane state to refund (mutated in place).
 * @example
 * ```ts
 * refundToken(lane);
 * ```
 */
export function refundToken(lane: LaneState): void {
  lane.tokens += 1;
}

/**
 * Computes the breaker's current phase: `"closed"` (no trip recorded),
 * `"open"` (tripped, still cooling down), or `"half-open"` (cooldown has
 * elapsed, a probe request may pass through).
 *
 * @param lane - Lane state to inspect.
 * @param now - Current time (ms epoch).
 * @returns The breaker's current phase.
 * @example
 * ```ts
 * breakerPhase(lane, Date.now());
 * ```
 */
export function breakerPhase(lane: LaneState, now: number): "closed" | "open" | "half-open" {
  if (lane.openUntil === 0) return "closed";
  return now < lane.openUntil ? "open" : "half-open";
}

/**
 * Records a request outcome against the breaker: `"ok"` resets the failure
 * count and closes the breaker; `"retryable-error"` advances the failure
 * count and (re)opens the breaker once `breakerThreshold` is reached.
 * Either outcome settles a pending half-open probe (clears `probing`).
 *
 * @param lane - Lane state to update (mutated in place).
 * @param config - Effective settings for this lane.
 * @param outcome - The observed request outcome.
 * @param now - Current time (ms epoch).
 * @example
 * ```ts
 * recordOutcome(lane, config, "ok", Date.now());
 * ```
 */
export function recordOutcome(
  lane: LaneState,
  config: LaneConfig,
  outcome: "ok" | "retryable-error",
  now: number
): void {
  lane.probing = false;

  if (outcome === "ok") {
    lane.consecutiveFailures = 0;
    lane.openUntil = 0;
    return;
  }

  lane.consecutiveFailures += 1;
  if (lane.consecutiveFailures >= config.breakerThreshold) {
    lane.openUntil = now + config.breakerCooldownMs;
  }
}
