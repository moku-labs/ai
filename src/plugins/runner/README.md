# runner

> The durable run orchestrator — queued → gate(budget+dedup, atomic) → execute → store → done. Owns all run events.

## Purpose

The runner is the execution heart of `@moku-labs/ai`: it turns declarative build files into
artifacts by driving every item of every task through one uniform, durable pipeline. A single
`run()` invocation opens exactly one `runs` journal row spanning every glob-matched build file,
plans each item into a canonical, key-order-independent planning key, and executes all queued
items concurrently — each admitted through a per-lane concurrency limiter
(`"{task}/{provider}/default"`), gated atomically against budget and duplicates, executed via the
handler registered for its task/provider pair, and persisted content-first (`store.put` before
`journal.commitDone`). Kill-9 safety sits beneath every feature: interrupted runs resume without
re-billing done items, and mid-flight items are simply re-queued.

Failures are classified into a contractual retry taxonomy (retry ONLY 5xx / 429 / timeout /
network with jittered exponential backoff; other 4xx is terminal `failed`; content-policy is
terminal `flagged`, never re-queued). External abort signals produce a clean pause — stop
admitting, drain in-flight items, resolve `{ status: "paused" }` — and a budget ceiling produces
the same graceful drain with `{ status: "budget-stopped" }`.

**Named constraints owned by this plugin:**

- **Per-item events NEVER touch the plugin bus** — hook dispatch is sequential-await, so a
  million items would serialize on the bus. The bus carries only coalesced `run:progress`
  (≤1 per 500ms) and run-level lifecycle events; all per-item detail flows through `events()`.
- **Redaction boundary** — nothing containing raw prompts, request/response bodies, or secrets
  ever crosses into `ctx.journal`. The runner passes only status/costs/hashes/error classes;
  raw content goes exclusively to `ctx.store`. The in-memory `HandlerRequest` (input/params) is
  never journaled.
- **Single active run per process (M0)** — starting a second `run()`/`resume()` while one is
  active throws.

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `maxAttempts` | `number` | `3` | Default max attempts per item. Overridable per build file via `defaults.maxAttempts`. |
| `retryBaseMs` | `number` | `1000` | Base backoff for retryable errors, ms. Exponential in the attempt number, jittered to 50–100% of the computed value; a provider `Retry-After` hint is honored when larger. |
| `eventBufferSize` | `number` | `10000` | `events()` per-consumer buffer: max unconsumed item records before overflow coalescing. |
| `pollIntervalMs` | `number` | `5000` | Delay between two polls of a provider job (`submit` + `poll` handlers). |
| `jobTimeoutMs` | `number` | `1800000` | A job still pending after this long is marked `expired`; the next attempt submits it again. |

```ts
const app = createApp({
  pluginConfigs: { runner: { maxAttempts: 5, retryBaseMs: 2000 } }
});
```

## API reference

Exposed as `app.runner` (and to dependent plugins via `ctx.require(runnerPlugin)`).

### `run(options, opts?): Promise<RunResult>`

Executes one durable run: opens a single `runs` journal row spanning every glob-matched build
file, plans and inserts every item, then drives the pipeline to completion.

- **`options.files?: string`** — glob pattern for build files; defaults to the buildfile
  plugin's configured default (the run's `glob` is recorded as `"(default)"`).
- **`options.maxCostUsd?: number`** — budget ceiling; when the atomic gate reports the budget
  reached, the run drains and settles `{ status: "budget-stopped" }`.
- **`options.dryRun?: boolean`** — short-circuits to a pure estimate: no journal writes, returns
  `runId: "dry-run"`, `status: "done"`, with the plan's total in `totals.estimatedRemainingUsd`.
- **`opts.signal?: AbortSignal`** — clean pause: on abort, stop admitting queued items, let
  dispatching items finish (handlers also receive the signal for best-effort cancellation), and
  resolve `{ status: "paused" }` once in-flight items drain.
- **Returns** `RunResult`: `{ runId, status: "done" | "failed" | "paused" | "budget-stopped", totals }`.
- **Throws** when a run is already active in this process. Unrecoverable errors *inside* the run
  (plan failures, missing handlers) do not reject — the run is marked `failed` and the promise
  resolves `{ status: "failed" }` after emitting `run:failed`.

```ts
const result = await app.runner.run({ files: "voice/*.moku.yaml", maxCostUsd: 25 });
```

### `resume(opts?): Promise<RunResult>`

Continues the latest resumable run (or a specific one by id): `requeueDispatching` re-queues any
items left mid-flight, then re-enters the pipeline for every currently queued item. Re-planning
is idempotent (`insertItems` no-ops on existing planning keys), so already-`done` items are never
re-billed.

- **`opts.runId?: string`** — run to resume; defaults to the latest resumable run.
- **`opts.signal?: AbortSignal`** — same clean-pause semantics as `run()`.
- **Returns** `RunResult` for the resumed run.
- **Throws** when a run is already active, when `opts.runId` doesn't exist, or when no
  resumable run exists.

```ts
const result = await app.runner.resume();
```

### `estimate(options): Promise<EstimateResult>`

Computes the SAME per-item estimate the budget gate uses: plans the matched build files and
totals each handler's `estimate(request).usd`, grouped by task/provider. No journal writes.

- **`options.files?: string`** — glob pattern; defaults like `run()`.
- **Returns** `EstimateResult`: `{ lines: { task, provider, items, usd }[], totalUsd }`.
- **Throws** when an item's provider can't be resolved or its handler isn't registered.

```ts
const { lines, totalUsd } = await app.runner.estimate({ files: "voice/*.moku.yaml" });
```

### `status(runId?): RunStatusReport`

Reads a read-only status snapshot for a run: the given `runId`, else the active run, else the
latest resumable run. Uses `journal.readSnapshot`, which is safe to call from a second process.

- **`runId?: string`** — run to report on; defaults as above.
- **Returns** `RunStatusReport`: `{ runId, status, totals, updatedAt }` (`updatedAt` is the most
  recently updated item's timestamp, falling back to the run's `createdAt`).
- **Throws** when no run id is given and none can be inferred.

```ts
const report = app.runner.status();
```

### `events(): AsyncIterable<RunEvent>`

Opens a per-item detail stream for the active run. When no run is active, returns an
already-closed empty stream.

**Backpressure contract:** each consumer gets a bounded queue of `config.eventBufferSize` item
records — on overflow the oldest ITEM records are dropped and coalesced into one
`{ type: "overflow", dropped: n }` marker; `"progress"` records coalesce (latest unconsumed
wins); a `"terminal"` record is ALWAYS delivered, after any buffered data, before the iterable
completes.

```ts
for await (const event of app.runner.events()) {
  if (event.type === "item:done") report(event.itemId, event.costUsd);
}
```

**`RunEvent` stream records** (discriminated on `type` — these never touch the plugin bus):

| Record | Fields | When |
|--------|--------|------|
| `item:queued` | `itemId, task, provider` | Item enters the pipeline |
| `item:dispatching` | `itemId` | Item passed the atomic gate |
| `item:done` | `itemId, costUsd, contentHash` | Artifact stored and committed |
| `item:retry` | `itemId, errorClass, attempt` | Retryable failure; item re-queued with backoff |
| `item:failed` | `itemId, errorClass` | Terminal failure (4xx, or attempts exhausted) |
| `item:flagged` | `itemId` | Content-policy rejection (terminal, never re-queued) |
| `overflow` | `dropped` | Consumer buffer overflowed; `dropped` oldest item records lost |
| `progress` | `totals` | Coalesced run totals (latest unconsumed wins) |
| `terminal` | `status, totals` | Run settled — always the last record delivered |

## Events (plugin bus)

The runner is the only event declarer at M0. It emits five bus events and listens to nothing.

| Event | Payload | When |
|-------|---------|------|
| `run:progress` | `{ runId, total, done, failed, flagged, spendUsd }` | Coalesced run progress, ≤1 per 500ms |
| `run:done` | `{ runId, totals: RunTotals }` | Run completed |
| `run:failed` | `{ runId, error: string }` | Run aborted by unrecoverable error |
| `run:budget-stop` | `{ runId, spendUsd, maxCostUsd }` | Budget ceiling reached; run drained + stopped |
| `run:paused` | `{ runId, drained }` | Clean pause completed (signal abort drained); `drained` = settled item count |

The `App` type has no `on()` method — subscribe from a plugin that declares `depends: [runnerPlugin]` and a `hooks` map:

```ts
import { createApp, createPlugin, runnerPlugin } from "@moku-labs/ai";

const reporterPlugin = createPlugin("reporter", {
  depends: [runnerPlugin],
  hooks: ctx => ({
    "run:progress": ({ done, total, spendUsd }) => render(done, total, spendUsd),
    "run:done": ({ runId, totals }) => summarize(runId, totals)
  })
});

const app = createApp({ plugins: [reporterPlugin] });
```

## The pipeline (per item)

1. **Plan** — compile build files (`buildfile.loadGlob`), order each build's items so `$ref`
   targets come first, resolve each item's provider (item `provider` → build
   `defaults.provider` → the task's first-registered provider), hash every `$file`, and compute
   two keys. Planning key = `sha256(canonicalJson({ task, input, params }))` with each `$ref`
   replaced by its target's planning key and each `$file` by its content hash (deliberately
   excludes `provider`). Artifact key = the same over `{ task, provider, packVersion, input,
   params }`, with `$ref`s replaced by the target's artifact key. The request is the flat task
   request `{ ...input, params }`; the handler estimates it (references unresolved).
   `journal.insertItems` writes the items `queued` with label (`id`, else `<NN>-<task>`), build
   name and artifact key (idempotent per run).
2. **Reuse** — `journal.findDoneArtifact(artifactKey)`: a `done` artifact from any run whose bytes
   are still in the store completes the item at $0, no provider call.
3. **References** — wait for the item's `$ref` targets to settle; a target that is not `done`
   blocks the item (it stays `queued`, the run ends `paused`). Otherwise each `$ref` becomes the
   target's stored file and each `$file` the local file, as `{ path, mimeType, hash }`.
4. **Admit** — `limits.acquire("{task}/{provider}/default", { signal })`. An abort or open
   breaker during the wait exits the item cleanly (it stays `queued`).
5. **Gate (atomic)** — `journal.gateToDispatching(itemId)`: budget check + dedup + state
   transition in ONE transaction. `"budget"` triggers the graceful budget-stop drain;
   `"duplicate"` releases the lane slot without dispatching (never billed).
6. **Execute** — `registry.resolve(task, provider)` narrowed through `isExecutableHandler()`
   (the runner's single audited dynamic boundary), `journal.recordAttempt`, then either the job
   path (below) or `handler.execute(request, { signal })`.
7. **Classify on error** — `classifyError` maps the thrown error into the journal taxonomy
   (see below); `limits.reportOutcome` feeds the breaker (`"ok"` / `"retryable-error"` only).
   When the drain signal fired and the error carries no provider hint, the attempt ends
   `aborted` and the item stays `dispatching` for `resume()`.
8. **Persist** — the result is normalized (`body` / `audio` / `image` / `video` bytes, or `text`),
   `store.put(bytes)` → `journal.commitDone(itemId, { actualCostUsd, artifactKey, contentHash,
   mimeType })`.
9. **Report** — item record to `events()` subscribers; coalesced `run:progress` on the bus.

A retryable failure returns the item to `queued` (`markFailed` with `terminal: false`) and
re-enters admit + gate after the backoff delay, until it settles or exhausts `maxAttempts`.

### Provider jobs (`submit` + `poll`)

A handler with both `submit` and `poll` always runs through the job path:

1. `journal.findLiveJob(artifactKey)` — a job still `submitted` for this artifact key, from any
   run (a crash, a pause, a timeout of the caller), is **adopted**: no new submit.
2. Otherwise `submit()`, then `journal.setAttemptJob(attemptId, { externalId: jobId,
   jobState: "submitted" })` immediately, before any wait.
3. `poll()` every `pollIntervalMs`. A thrown retryable error (5xx / 429 / timeout / network) is a
   transport problem and keeps polling. `{ state: "failed", error }` or a thrown terminal error
   marks the job `failed`; the error is classified as usual, and a retryable one re-submits on
   the next attempt. `{ state: "done", ... }` marks it `done` and persists as above.
4. After `jobTimeoutMs` the job is marked `expired` and the attempt fails with a retryable
   `timeout`, so the next attempt submits a fresh job.

### Retry taxonomy (contractual)

| Error class | Classified from | Outcome |
|-------------|-----------------|---------|
| `http-5xx` | `status >= 500` | Retry with backoff |
| `http-429` | `status === 429` | Retry with backoff (`Retry-After` honored when larger) |
| `timeout` | `kind: "timeout"` | Retry with backoff |
| `network` | `kind: "network"` | Retry with backoff |
| `http-4xx` | `400 <= status < 500` (except 429) | Terminal `failed` |
| `content-policy` | `kind: "content-policy"` | Terminal `flagged`, never re-queued |
| `unknown` | no hint at all (a `TypeError`, a plain `Error`, a string) | Terminal `failed` after one attempt — a programming error must never re-run a paid job |

Provider handlers steer classification by attaching an optional structural hint
(`ProviderErrorHint`) to their thrown errors — `status?: number`,
`kind?: "timeout" | "network" | "content-policy"` (overrides status), and `retryAfterMs?: number`.

### The handler protocol

Every registered task/provider handler must satisfy `ExecutableHandler` — validated at runtime,
once, before use (the registry itself never types what it transports):

```ts
type HandlerRequest = Record<string, unknown>; // { ...item.input, params }
type HandlerResult = {
  body?: Uint8Array; audio?: Uint8Array; image?: Uint8Array; video?: Uint8Array; text?: string;
  mimeType?: string; costUsd: number; meta?: Record<string, unknown>;
};
type JobPoll =
  | { state: "pending" }
  | ({ state: "done" } & HandlerResult)
  | { state: "failed"; error: unknown };

type ExecutableHandler = {
  estimate(request: HandlerRequest): { usd: number };
  execute?(request: HandlerRequest, opts: { signal?: AbortSignal }): Promise<HandlerResult>;
  submit?(request: HandlerRequest, opts: { signal?: AbortSignal }): Promise<{ jobId: string }>;
  poll?(jobId: string, request: HandlerRequest, opts: { signal?: AbortSignal }): Promise<JobPoll>;
};
```

`estimate` plus `execute`, or `estimate` plus `submit` + `poll`. The request is the task
contract's own request (`VoiceoverRequest`, `VideoRequest`, …): the build item's `input` spread
flat plus `params`. `$ref` / `$file` values arrive as `{ path, mimeType, hash }` in `execute`,
`submit` and `poll`, and unresolved in `estimate`.

### `export(opts?): Promise<ExportResult>`

Copies every `done` artifact of a run (default: the newest run) to
`<outDir>/<build name>/<label>.<ext>` (default `outDir`: `"out"`). The extension comes from the
stored mime type. Labels with `..` or an absolute path are skipped and listed in `skipped`.

```ts
const { files } = await app.runner.export({ outDir: "out" });
// [{ label: "e01.s01.h3", path: "/repo/out/ep01/e01.s01.h3.mp4", bytes: 4_812_331, costUsd: 0.3, mimeType: "video/mp4" }]
```

## Usage

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({});
await app.start();

// Estimate first, then run with a budget ceiling
const { totalUsd } = await app.runner.estimate({ files: "voice/*.moku.yaml" });
const result = await app.runner.run({ files: "voice/*.moku.yaml", maxCostUsd: totalUsd * 1.2 });
// result.status: "done" | "failed" | "paused" | "budget-stopped"

await app.stop();
```

Clean pause on Ctrl-C, with a live per-item stream:

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({});
await app.start();

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());

const runPromise = app.runner.run(
  { files: "**/*.moku.yaml", maxCostUsd: 25 },
  { signal: controller.signal }
);

// Separate consumer: per-item detail (never on the bus)
for await (const event of app.runner.events()) {
  if (event.type === "item:done") report(event.itemId, event.costUsd);
  if (event.type === "item:retry") warn(event.itemId, event.errorClass, event.attempt);
  if (event.type === "terminal") break;
}

const result = await runPromise;
if (result.status === "paused") {
  // Later — continue exactly where the run left off; done items are never re-billed
  await app.runner.resume({ runId: result.runId });
}
```

Dry run and status from a second process:

```ts
// No journal writes; totals.estimatedRemainingUsd carries the plan's total
const dry = await app.runner.run({ files: "voice/*.moku.yaml", dryRun: true });

// Read-only snapshot (journal.readSnapshot — safe from a second process)
const report = app.runner.status();
```

## Integration

**Dependencies (declared, via `ctx.require`):**

- `registryPlugin` — `resolve(task, provider)` per item (narrowed through
  `isExecutableHandler`), and `providers(task)` for default-provider fallback at plan time.
- `buildfilePlugin` — `loadGlob(files)` compiles matched build files for `run`, `resume`, and
  `estimate`.

**Core infrastructure (injected on `ctx`):**

- `ctx.journal` — the durable state machine: `openRun`/`insertItems`/`gateToDispatching`/
  `recordAttempt`/`finishAttempt`/`commitDone`/`markFailed`/`markFlagged`/`requeueDispatching`/
  `totals`/`readSnapshot`/`latestResumableRun`. Receives only status/costs/hashes/error classes.
- `ctx.store` — content-addressed artifact storage; `store.put(body)` runs before
  `journal.commitDone` so a committed item always has its bytes.
- `ctx.limits` — per-lane concurrency (`acquire`) and the circuit breaker (`reportOutcome`).
  Lanes are `"{task}/{provider}/default"` at M0 (no account pools yet).
- `ctx.log` — structured diagnostics (e.g. `runner:stale-item` for journal rows with no
  matching planned item).

**Dependents:**

- `cliPlugin` — depends on the runner and drives `run`/`resume`/`estimate`/`status`/`events()`
  for the CLI's run, pause (SIGINT → AbortSignal), usage, and budget-stop flows.
- Task plugins (`voiceover`, `translate`, `promptGen`) register their provider handlers with the
  registry; the runner executes them without ever knowing their concrete types.
