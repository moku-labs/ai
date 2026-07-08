/**
 * Core plugin (Standard tier) — per-lane token bucket + concurrency gate +
 * circuit breaker (lane = task/provider/account). ctx.limits.
 *
 * @see README.md
 */
import { createCorePlugin } from "@moku-labs/core";
import { createLimitsApi } from "./api";
import { createLimitsState } from "./state";
import type { Config } from "./types";

const defaultConfig: Config = {
  defaults: { rpm: 60, concurrency: 4, breakerThreshold: 5, breakerCooldownMs: 30_000 },
  lanes: {}
};

/**
 * limits — Core plugin (Standard tier). Per-lane throughput control; injected as ctx.limits.
 *
 * @see README.md
 */
export const limitsPlugin = createCorePlugin("limits", {
  config: defaultConfig,
  createState: createLimitsState,
  api: createLimitsApi
});
