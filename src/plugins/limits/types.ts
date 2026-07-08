/**
 * @file limits core plugin — type definitions.
 */

/**
 * Effective throughput settings for a single lane: token-bucket rate,
 * concurrency ceiling, and circuit-breaker trip/cooldown thresholds.
 */
export type LaneConfig = {
  /** Max requests per minute for the lane. Default: 60. */
  rpm: number;
  /** Max concurrent in-flight requests for the lane. Default: 4. */
  concurrency: number;
  /** Consecutive retryable failures that open the breaker. Default: 5. */
  breakerThreshold: number;
  /** How long an open breaker stays open before half-open probe, ms. Default: 30_000. */
  breakerCooldownMs: number;
};

/**
 * `limits` plugin configuration: fallback lane settings plus optional
 * per-lane overrides, keyed by either the exact lane string
 * (`"{task}/{provider}/{account}"`) or a `"{task}/{provider}"` prefix.
 */
export type Config = {
  /** Fallback lane settings. */
  defaults: LaneConfig;
  /** Per-lane overrides, keyed by exact lane string or "{task}/{provider}" prefix. */
  lanes: Record<string, Partial<LaneConfig>>;
};

/**
 * Mutable runtime state for a single lane: token bucket, in-flight count,
 * FIFO concurrency waiters, and circuit-breaker bookkeeping. Created lazily
 * on first acquire/report for a given lane key.
 */
export type LaneState = {
  /** Tokens currently available in the bucket (may go negative for a pending reservation). */
  tokens: number;
  /** Timestamp (ms epoch) tokens were last refilled against. */
  lastRefillAt: number;
  /** Count of requests currently holding a concurrency slot. */
  inFlight: number;
  /** FIFO of waiters resolved (in order) as a concurrency slot frees up. */
  waiters: Array<() => void>;
  /** Consecutive retryable failures observed since the breaker last closed. */
  consecutiveFailures: number;
  /** Timestamp (ms epoch) the breaker stays open until; 0 means closed. */
  openUntil: number;
  /** Whether the single half-open trial probe is currently in flight (settled by reportOutcome). */
  probing: boolean;
};

/** Root `limits` state: every lane currently tracked, keyed by lane string. */
export type State = { lanes: Map<string, LaneState> };

/** Read-only introspection snapshot of a lane's current admission-control status, for `moku status`. */
export type LaneSnapshot = {
  /** The lane key this snapshot describes. */
  lane: string;
  /** Tokens currently available in the bucket. */
  tokens: number;
  /** Count of requests currently holding a concurrency slot. */
  inFlight: number;
  /** Count of callers currently queued for a concurrency slot. */
  waiting: number;
  /** Current circuit-breaker phase. */
  breaker: "closed" | "open" | "half-open";
};

/**
 * `limits` plugin API, injected as `ctx.limits` on every regular plugin's
 * context. Provides per-lane admission control (token bucket + concurrency
 * gate + circuit breaker) and read-only introspection.
 */
export type LimitsApi = {
  /**
   * Waits for lane capacity: breaker closed (or a half-open probe slot), a
   * token available, and a concurrency slot. Resolves with a release
   * function that MUST be called exactly once when the request settles.
   * Rejects immediately (reason `"breaker-open"`) when the breaker is open.
   * An aborted wait leaves no leaked token or concurrency slot.
   */
  acquire(lane: string, opts?: { signal?: AbortSignal }): Promise<{ release: () => void }>;
  /**
   * Feeds the circuit breaker with a request outcome: `"ok"` closes/resets
   * it; `"retryable-error"` advances it toward open. Terminal 4xx responses
   * should NOT be reported here — they are deterministic, not a health signal.
   */
  reportOutcome(lane: string, outcome: "ok" | "retryable-error"): void;
  /** Effective settings for a lane: defaults merged with prefix and exact overrides. */
  laneConfig(lane: string): LaneConfig;
  /** Introspection snapshot for a lane: tokens, in-flight, waiting, breaker phase. */
  snapshot(lane: string): LaneSnapshot;
  /** All lane keys currently tracked (touched by at least one acquire/reportOutcome call). */
  lanes(): string[];
};
