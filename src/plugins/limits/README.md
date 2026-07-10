# limits

> Per-lane admission control — token-bucket rate limiting, a concurrency gate, and a circuit breaker, injected as `ctx.limits`.

## Purpose

Every external call the build system makes — an ElevenLabs voiceover render, an OpenAI translation batch — is subject to provider rate limits and transient outages. The `limits` plugin is the framework's single admission-control point for all of that traffic. It keys everything by a **lane** string, `"{task}/{provider}/{account}"` (the account segment is always `"default"` at M0), and gives each lane three independent guards: a token bucket capping requests per minute, a FIFO concurrency gate capping in-flight requests, and a circuit breaker that trips after consecutive retryable failures and heals via a half-open probe.

It is a **core plugin** (Standard tier), registered in `createCoreConfig` alongside `journal` and `store`, so `ctx.limits` is available on every regular plugin's context and as `app.limits` on the assembled app. It is deliberately bespoke — research found no off-the-shelf per-group limiter in OSS (BullMQ's is Pro-only). The design is timer-free: token refill and breaker transitions are lazy timestamp math computed on demand (the only timers are one-shot, self-clearing `setTimeout` calls for an exact computed deadline), so the plugin needs no `onStart`/`onStop` lifecycle. Pending waiters simply die with the process — the work they gate is journal-`queued`/`dispatching` and resumes safely by design.

## Configuration

Config shape (`Config` in `types.ts`):

```ts
type Config = {
  defaults: LaneConfig;
  lanes: Record<string, Partial<LaneConfig>>;
};
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `defaults.rpm` | `number` | `60` | Max requests per minute for a lane (also the token-bucket capacity). |
| `defaults.concurrency` | `number` | `4` | Max concurrent in-flight requests for a lane. |
| `defaults.breakerThreshold` | `number` | `5` | Consecutive retryable failures that open the breaker. |
| `defaults.breakerCooldownMs` | `number` | `30_000` | How long an open breaker stays open before the half-open probe, in ms. |
| `lanes` | `Record<string, Partial<LaneConfig>>` | `{}` | Per-lane overrides, keyed by the exact lane string (`"{task}/{provider}/{account}"`) or a `"{task}/{provider}"` prefix. |

Merge precedence (resolved per lane by `laneConfig`): **exact lane override → `"task/provider"` prefix override → `defaults`**.

Limits is a Core plugin, so its config lives at Layer 1 — it is set where `createCore` is called, not by consumer apps. `createApp`'s `pluginConfigs` is typed to **regular plugins only**; the framework calls `createCore` with `pluginConfigs: {}`, so at M0 the defaults above (60 rpm / 4 concurrent per lane) are fixed for Layer-3 apps. The config shape, for Layer-2 callers of `createCore(coreConfig, { pluginConfigs })`:

```ts
{
  limits: {
    defaults: { rpm: 60, concurrency: 4, breakerThreshold: 5, breakerCooldownMs: 30_000 },
    lanes: {
      // Prefix override: applies to every account on this task/provider pair.
      "voiceover/elevenlabs": { rpm: 20, concurrency: 2 },
      // Exact override: wins over the prefix for this specific lane.
      "voiceover/elevenlabs/default": { breakerCooldownMs: 60_000 }
    }
  }
}
```

## API reference (`ctx.limits.*`)

The full surface is the `LimitsApi` type. Lane state is created lazily — a lane exists once it has seen at least one `acquire` or `reportOutcome` call.

### `acquire(lane, opts?)`

```ts
acquire(lane: string, opts?: { signal?: AbortSignal }): Promise<{ release: () => void }>;
```

Waits for lane capacity in three stages: breaker closed (or the single half-open probe slot), a token available, and a concurrency slot (FIFO-fair). Resolves with a handle whose `release()` **must be called exactly once** when the request settles (it is a no-op after the first call). Releasing hands the freed concurrency slot to the next queued waiter.

- **Params:** `lane` — lane key; `opts.signal` — optional `AbortSignal` for a clean-cancel wait.
- **Returns:** `Promise<{ release: () => void }>`.
- **Throws:**
  - Rejects **immediately** with an `Error` tagged `reason: "breaker-open"` when the lane's breaker is open (or when it is half-open and the probe slot is already claimed). Branch on the tag, not the message.
  - Rejects with `signal.reason` (or a default two-line error) if the signal aborts during the wait. An aborted wait leaks nothing: the reserved token is refunded, the waiter is removed from the queue, and a claimed probe slot is released.

```ts
const { release } = await ctx.limits.acquire("voiceover/elevenlabs/default", {
  signal: drain.signal
});
try {
  await callProvider();
} finally {
  release();
}
```

### `reportOutcome(lane, outcome)`

```ts
reportOutcome(lane: string, outcome: "ok" | "retryable-error"): void;
```

Feeds the circuit breaker with a request outcome. `"ok"` resets the failure count and closes the breaker; `"retryable-error"` (429s, 5xx, timeouts) advances the failure count and (re)opens the breaker once `breakerThreshold` consecutive failures are reached. Either outcome settles a pending half-open probe. **Terminal 4xx responses should NOT be reported** — they are deterministic, not a lane-health signal.

- **Params:** `lane` — lane key; `outcome` — `"ok" | "retryable-error"`.
- **Returns:** `void`. Never throws.

```ts
ctx.limits.reportOutcome("voiceover/elevenlabs/default", "retryable-error");
```

### `laneConfig(lane)`

```ts
laneConfig(lane: string): LaneConfig;
```

Returns the effective settings for a lane: `defaults` merged with the `"task/provider"` prefix override and the exact-lane override (exact wins over prefix, prefix wins over defaults). Pure lookup — does not create or touch lane state.

```ts
const { rpm, concurrency } = ctx.limits.laneConfig("translate/openai/default");
```

### `snapshot(lane)`

```ts
snapshot(lane: string): LaneSnapshot;
```

Read-only introspection for a lane, intended for `moku status`. Refills the token bucket lazily before reading so the numbers are current. A never-touched lane returns a pristine snapshot (`tokens` = `rpm`, breaker `"closed"`) **without** registering the lane.

- **Returns:** `LaneSnapshot` — `{ lane, tokens, inFlight, waiting, breaker }` where `breaker` is `"closed" | "open" | "half-open"`.

```ts
const snap = ctx.limits.snapshot("voiceover/elevenlabs/default");
// => { lane: "...", tokens: 58.2, inFlight: 2, waiting: 1, breaker: "closed" }
```

### `lanes()`

```ts
lanes(): string[];
```

Returns all lane keys currently tracked — i.e. lanes touched by at least one `acquire` or `reportOutcome` call. Useful for iterating snapshots in status displays.

```ts
for (const lane of ctx.limits.lanes()) {
  ctx.log.info("lane status", ctx.limits.snapshot(lane));
}
```

## Events

None. `limits` is a core plugin with a pure request/response API — it emits no events and listens to none, and declares no `depends` or lifecycle hooks. Breaker trips surface synchronously as the tagged `"breaker-open"` rejection from `acquire`, not as an event.

## Usage examples

### Gating an external call in a custom plugin

```ts
import { createPlugin } from "@moku-labs/ai";

export const fetcherPlugin = createPlugin("fetcher", {
  api: ctx => ({
    async fetchAsset(url: string): Promise<Response> {
      const lane = "fetch/http/default";
      const { release } = await ctx.limits.acquire(lane);
      try {
        const response = await fetch(url);
        const retryable = response.status === 429 || response.status >= 500;
        ctx.limits.reportOutcome(lane, retryable ? "retryable-error" : "ok");
        return response;
      } catch (error) {
        ctx.limits.reportOutcome(lane, "retryable-error");
        throw error;
      } finally {
        release();
      }
    }
  })
});
```

### Handling an open breaker

```ts
try {
  const { release } = await ctx.limits.acquire(lane);
  // ... perform the request, then release()
} catch (error) {
  if ((error as { reason?: string }).reason === "breaker-open") {
    // Lane is unhealthy — skip for now; retry after the cooldown or fail over.
    return;
  }
  throw error;
}
```

### Cancellable waits (drain / pause)

```ts
const drain = new AbortController();

const pending = ctx.limits.acquire(lane, { signal: drain.signal });
drain.abort(); // rejects the wait; no token or slot is leaked
```

### Inspecting lanes from the app surface

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({});
const snapshots = app.limits.lanes().map(lane => app.limits.snapshot(lane));
```

## Integration

- **Registration** — wired as a core plugin in `src/config.ts` (`createCoreConfig("ai", { plugins: [logPlugin, envPlugin, journalPlugin, storePlugin, limitsPlugin] })`), so every regular plugin's `ctx` carries `limits` and the app exposes `app.limits`.
- **`runner` (primary consumer)** — the runner pipeline's admission stage computes the lane as `"{item.task}/{item.provider}/default"` and calls `acquire(lane, { signal })` with its drain signal, treating a breaker-open rejection or abort as "skip this item for now". After each provider call it feeds the breaker: `reportOutcome(lane, "ok")` on success, `reportOutcome(lane, "retryable-error")` on retryable failure. Its domain context (`RunnerContext` in `src/plugins/runner/types.ts`) types `limits: LimitsApi` directly.
- **Provider plugins (`elevenlabs`, `openai`)** — do not call `ctx.limits` themselves; their handlers run inside the runner's admit → dispatch pipeline, so their traffic is already lane-gated.
- **`cli` / `moku status`** — `snapshot(lane)` and `lanes()` exist for status-style introspection of live throughput state.
- **`journal`** — no direct coupling, but the timer-free/no-lifecycle design leans on it: waiters killed mid-wait are safe because their items remain journal-`queued`/`dispatching` and resume on the next run.
- **Exports** — `limitsPlugin` and the `Limits` type namespace (`Limits.LimitsApi`, `Limits.LaneConfig`, `Limits.LaneSnapshot`, ...) are re-exported from `"@moku-labs/ai"` via `src/plugins/index.ts`.
