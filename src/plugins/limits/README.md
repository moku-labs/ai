# limits

> Core·Standard plugin — per-lane token bucket + concurrency gate + circuit breaker

Per-lane throughput control for the build system: a token-bucket rate limiter, a concurrency
gate, and a circuit breaker, all keyed by a lane string `"{task}/{provider}/{account}"` (the M0
account segment is always `"default"`). Injected as `ctx.limits` on every regular plugin's
context; the `runner` plugin is its primary consumer.

There are no timers, sockets, or lifecycle hooks in this plugin — the token bucket is lazy
timestamp math computed on demand, and pending waiters simply die with the process (the work
they gate is journal-queued/dispatching and resumes safely by design).

## API

- `acquire(lane, opts?)` — Waits for lane capacity: breaker closed (or a half-open probe slot), a
  token available, and a concurrency slot. Resolves with `{ release }`; `release()` MUST be
  called exactly once when the request settles. Rejects immediately (tagged
  `reason: "breaker-open"`) when the breaker is open. Accepts `opts.signal` — an aborted wait
  leaves no leaked token or concurrency slot.
- `reportOutcome(lane, outcome)` — Feeds the breaker: `"ok"` closes/resets it; `"retryable-error"`
  advances it toward open. Terminal 4xx errors should NOT be reported here — they are
  deterministic, not a lane health signal.
- `laneConfig(lane)` — Effective settings for a lane (defaults merged with `"task/provider"`
  prefix and exact overrides; exact wins over prefix, prefix wins over defaults).
- `snapshot(lane)` — Introspection for `moku status`: tokens, in-flight count, waiting count, and
  breaker phase (`"closed" | "open" | "half-open"`).
- `lanes()` — All lane keys currently tracked (touched by at least one `acquire`/`reportOutcome`
  call).

## Configuration

```ts
type LaneConfig = {
  rpm: number; // Max requests per minute for the lane. Default: 60.
  concurrency: number; // Max concurrent in-flight requests. Default: 4.
  breakerThreshold: number; // Consecutive retryable failures that open the breaker. Default: 5.
  breakerCooldownMs: number; // Open-breaker cooldown before half-open probe, ms. Default: 30_000.
};

type Config = {
  defaults: LaneConfig;
  lanes: Record<string, Partial<LaneConfig>>; // keyed by exact lane or "task/provider" prefix
};
```
