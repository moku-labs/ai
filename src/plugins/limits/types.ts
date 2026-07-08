/**
 * @file limits core plugin — type definitions.
 */
export type LaneConfig = {
  /** Max requests per minute for the lane. */
  rpm: number;
  /** Max concurrent in-flight requests. */
  concurrency: number;
  /** Consecutive retryable failures that open the breaker. */
  breakerThreshold: number;
  /** Open-breaker cooldown before half-open probe, ms. */
  breakerCooldownMs: number;
};

/**
 *
 */
export type Config = {
  /** Fallback lane settings. */
  defaults: LaneConfig;
  /** Per-lane overrides by exact lane or "task/provider" prefix. */
  lanes: Record<string, Partial<LaneConfig>>;
};

/**
 *
 */
export type LaneState = {
  tokens: number;
  lastRefillAt: number;
  inFlight: number;
  waiters: Array<() => void>;
  consecutiveFailures: number;
  openUntil: number;
};

/**
 *
 */
export type State = { lanes: Map<string, LaneState> };

/**
 *
 */
export type LaneSnapshot = {
  lane: string;
  tokens: number;
  inFlight: number;
  waiting: number;
  breaker: "closed" | "open" | "half-open";
};

/**
 *
 */
export type LimitsApi = {
  acquire(lane: string, opts?: { signal?: AbortSignal }): Promise<{ release: () => void }>;
  reportOutcome(lane: string, outcome: "ok" | "retryable-error"): void;
  laneConfig(lane: string): LaneConfig;
  snapshot(lane: string): LaneSnapshot;
  lanes(): string[];
};
