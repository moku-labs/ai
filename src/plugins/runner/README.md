# runner

> Complex plugin — the durable run orchestrator: queued → gate(budget+dedup, atomic) → execute → store → done. Owns all run events.

One `run()` invocation = exactly one `runs` journal row spanning every matched build file. The
runner owns the uniform per-item execution pipeline for every task, the retry taxonomy, resume,
estimation, status, and the `events()` AsyncIterable. Kill-9 safety is the layer beneath every
feature: the falsifiable contract is `spend <= done_items + dispatching_at_kill`.

**Named constraints owned by this plugin:**

- **Per-item events NEVER touch the plugin bus** — hook dispatch is sequential-await, so 1M items
  would serialize on the bus. The bus carries only coalesced `run:progress` (≤1 per 500ms) and
  run-level lifecycle events; all per-item detail flows through `events()`.
- **Redaction boundary** — nothing containing raw prompts, request/response bodies, or secrets
  ever crosses into `ctx.journal`. The runner passes only status/costs/hashes/error classes;
  raw content goes exclusively to `ctx.store`.

## Config

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `maxAttempts` | `number` | `3` | Default max attempts per item (overridable per build file via `defaults.maxAttempts`). |
| `retryBaseMs` | `number` | `1000` | Base backoff for retryable errors, ms (exponential, jittered; `Retry-After` honored when larger). |
| `eventBufferSize` | `number` | `10000` | `events()` per-consumer buffer: max unconsumed item records before overflow coalescing. |

## The pipeline (per item)

1. **Plan** — compile build files (`buildfile.loadGlob`), compute the planning key
   `sha256(canonicalJson({task, input, params}))`, skip items already `done` (incremental by
   default), `journal.insertItems` as `queued` (idempotent on resume).
2. **Admit** — `limits.acquire("{task}/{provider}/default", { signal })`.
3. **Gate (atomic)** — `journal.gateToDispatching(itemId)`: budget + planning-key dedup + state
   transition in ONE transaction. `"budget"` → graceful drain, `budget-stopped`. `"duplicate"` →
   slot released, item never dispatched (never billed).
4. **Execute** — `registry.resolve(task, provider)`, narrowed through `isExecutableHandler()`
   (the runner's single audited dynamic boundary), then `handler.execute(input, { signal })`.
5. **Classify on error** — retry ONLY 5xx / 429 / timeout / network (honoring `Retry-After` when
   larger than backoff); 4xx (except 429) = terminal `failed`; content-policy rejection =
   terminal `flagged`, never re-queued.
6. **Persist** — `store.put(result.body)` → `journal.commitDone(itemId, { actualCostUsd,
   artifactKey, contentHash })`.
7. **Report** — item record to `events()` subscribers; coalesced `run:progress` on the bus.

## API

### `run(options, opts?): Promise<RunResult>`
Execute one durable run (ONE runs row across all glob matches). `options`: `files?` (glob),
`maxCostUsd?` (budget ceiling), `dryRun?`. Clean pause: when `opts.signal` aborts, the runner
stops admitting queued items, lets dispatching items finish (handlers receive the signal for
best-effort fetch cancellation), flushes the journal, and resolves `{ status: "paused" }`.

### `resume(opts?): Promise<RunResult>`
Continue the latest resumable run (or `opts.runId`): requeue `dispatching` items, then re-enter
the pipeline for all `queued` items. Never re-bills `done` items.

### `estimate(options): Promise<EstimateResult>`
The SAME per-item estimate the budget gate uses (one number per item, resolved provider).
Returns `{ lines: { task, provider, items, usd }[], totalUsd }`. No journal writes.

### `status(runId?): RunStatusReport`
Read-only snapshot for `moku status` (via `journal.readSnapshot` — safe from a second process).

### `events(): AsyncIterable<RunEvent>`
Per-item detail stream for the active run. Backpressure: bounded per-consumer queue
(`config.eventBufferSize`); on overflow the oldest ITEM records are dropped and replaced by one
`{ type: "overflow", dropped: n }` marker; `progress` records coalesce (latest wins). A terminal
record (`done`/`failed`/`paused`/`budget-stop`) is ALWAYS delivered before the iterable completes.

## Events (plugin bus)

| Event | Payload | When |
|-------|---------|------|
| `run:progress` | `{ runId, total, done, failed, flagged, spendUsd }` | Coalesced, ≤1 per 500ms |
| `run:done` | `{ runId, totals }` | Run completed |
| `run:failed` | `{ runId, error }` | Run aborted by unrecoverable error |
| `run:budget-stop` | `{ runId, spendUsd, maxCostUsd }` | Budget ceiling reached; run drained + stopped |
| `run:paused` | `{ runId, drained }` | Clean pause completed (signal abort drained) |

## Dependencies

- `registryPlugin` — `resolve(task, provider)` per item, `providers(task)` for default-provider fallback.
- `buildfilePlugin` — `loadGlob`/`compile` at plan time (run, resume, estimate).
- Core: `ctx.journal.*`, `ctx.store.*`, `ctx.limits.*`, `ctx.log`.

## Usage

```typescript
const app = createApp({});
await app.start();

// Durable run with a budget ceiling and clean-pause wiring
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());

const result = await app.runner.run(
  { files: "**/*.moku.yaml", maxCostUsd: 25 },
  { signal: controller.signal }
);

// Per-item detail stream (separate consumer)
for await (const event of app.runner.events()) {
  if (event.type === "item:done") console.log(event.itemId, event.costUsd);
}

// Estimate without executing
const { totalUsd } = await app.runner.estimate({ files: "**/*.moku.yaml" });
```
