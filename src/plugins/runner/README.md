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
- **Runs per process are capped** — `maxActiveRuns` (default 1) runs may be active at once;
  one more `run()`/`resume()` throws. See [Several runs at once](#several-runs-at-once).

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `maxAttempts` | `number` | `3` | Default max attempts per item. Overridable per build file via `defaults.maxAttempts`. |
| `retryBaseMs` | `number` | `1000` | Base backoff for retryable errors, ms. Exponential in the attempt number, jittered to 50–100% of the computed value; a provider `Retry-After` hint is honored when larger. |
| `eventBufferSize` | `number` | `10000` | `events()` per-consumer buffer: max unconsumed item records before overflow coalescing. |
| `pollIntervalMs` | `number` | `5000` | Delay between two polls of a provider job (`submit` + `poll` handlers). |
| `jobTimeoutMs` | `number` | `1800000` | A job still pending after this long is marked `expired`; the next attempt polls it again before it submits a new one. |
| `maxActiveRuns` | `number` | `1` | How many runs this process drives at once. A whole number >= 1; anything else makes `run()`/`resume()` throw. `1` keeps the one-run-at-a-time refusal. |

```ts
const app = createApp({
  pluginConfigs: { runner: { maxAttempts: 5, retryBaseMs: 2000, maxActiveRuns: 2 } }
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
  resolve `{ status: "paused" }` once in-flight items drain. It pauses this run only.
- **`opts.onStart?: (runId: string) => void`** — called once, synchronously, with the new run id,
  before any item record. Open `events({ runId })` here to see the whole run. A throwing
  `onStart` fails the run.
- **Returns** `RunResult`: `{ runId, status: "done" | "failed" | "paused" | "budget-stopped", totals }`.
- **Throws** when `maxActiveRuns` is not a whole number >= 1, or when `maxActiveRuns` runs are
  already active (`[ai] A run is already active: <ids>.`). Unrecoverable errors *inside* the run
  (plan failures, missing handlers) do not reject — the run is marked `failed` and the promise
  resolves `{ status: "failed" }` after emitting `run:failed`. When one item hits such an error
  mid-run, the run's other items are stopped like a pause, and the run resolves `failed` only
  after all of them settled: no item keeps calling a provider for a failed run. Its remaining
  items stay `queued` / `dispatching`. Continue them with `resume({ runId })` once the bug is
  fixed; `resume()` without an id skips `failed` runs.

```ts
const result = await app.runner.run({ files: "voice/*.moku.yaml", maxCostUsd: 25 });
```

### `resume(opts?): Promise<RunResult>`

Continues the latest resumable run (or a specific one by id): `requeueDispatching` re-queues any
items left mid-flight, then re-enters the pipeline for every currently queued item. Re-planning
is idempotent (`insertItems` no-ops on existing planning keys), so already-`done` items are never
re-billed.

- **`opts.runId?: string`** — run to resume; defaults to the newest resumable run that this
  process does not drive now.
- **`opts.signal?: AbortSignal`** — same clean-pause semantics as `run()`.
- **`opts.onStart?: (runId: string) => void`** — same as `run()`.
- **Returns** `RunResult` for the resumed run.
- **Throws** in this order: `maxActiveRuns` invalid; `maxActiveRuns` runs already active;
  `opts.runId` is a run this process drives now (`[ai] Run is already active in this process:
  <id>.` — follow it with `events({ runId })` instead); `opts.runId` doesn't exist; no resumable
  run exists.

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

Reads a read-only status snapshot for a run: the given `runId`, else the newest active run, else
the latest resumable run. Uses `journal.readSnapshot`, which is safe to call from a second process.

- **`runId?: string`** — run to report on; defaults as above.
- **Returns** `RunStatusReport`: `{ runId, status, totals, updatedAt }` (`updatedAt` is the most
  recently updated item's timestamp, falling back to the run's `createdAt`).
- **Throws** when no run id is given and none can be inferred.

```ts
const report = app.runner.status();
```

### `events(opts?): AsyncIterable<RunEvent>`

Opens a per-item detail stream.

- **`events({ runId })`** — that run's records only. Closes after the run's `terminal` record.
  An already-closed empty stream when that run is not active.
- **`events()`** — the records of every run active now and every run started later. Closes once
  no run is active. An already-closed empty stream when no run is active.

**Backpressure contract:** each consumer gets one bounded queue of `config.eventBufferSize` item
records across all the runs it follows — on overflow the oldest ITEM records are dropped and
coalesced into one `{ type: "overflow", runId, dropped: n }` marker per run; `"progress"`
records coalesce per run (latest unconsumed wins); one `"terminal"` record per run is ALWAYS
delivered, after that run's buffered records.

```ts
for await (const event of app.runner.events()) {
  if (event.type === "item:done") report(event.runId, event.itemId, event.costUsd);
}
```

**`RunEvent` stream records** (discriminated on `type` — these never touch the plugin bus). Every
record also carries `runId`, the run it belongs to:

| Record | Fields | When |
|--------|--------|------|
| `item:queued` | `runId, itemId, task, provider` | Item enters the pipeline |
| `item:dispatching` | `runId, itemId` | Item passed the atomic gate |
| `item:done` | `runId, itemId, costUsd, contentHash, contentHashes?` | Artifact stored and committed (`costUsd: 0` when reused). `contentHashes` lists every output hash in order, only for a [multi-output item](#multi-output-items) |
| `item:retry` | `runId, itemId, errorClass, attempt` | Retryable failure; item re-queued with backoff |
| `item:failed` | `runId, itemId, label, errorClass, message?` | Terminal failure (4xx, `invalid-request`, `local-failure`, `unknown`, or attempts exhausted). `label` is the build-file id, `null` on old rows. `message` is the handler's `publicMessage` when it is a non-empty string, else our own `[ai]` error text, else absent: the first two lines, max 300 chars. Attempts exhausted carries the last attempt's message. A dedupe follower carries the leader's message. |
| `item:flagged` | `runId, itemId, message?` | Content-policy rejection (terminal, never re-queued). `message` follows the `item:failed` rule. A dedupe follower carries the leader's message. |
| `overflow` | `runId, dropped` | Consumer buffer overflowed; `dropped` oldest item records of that run lost |
| `progress` | `runId, totals` | Coalesced run totals (latest unconsumed wins) |
| `terminal` | `runId, status, totals` | Run settled — always the last record of that run |

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
   two keys. An image `$file` gets its MIME from its first bytes (PNG, JPEG, GIF, WEBP). When the
   bytes disagree with the extension, the bytes win and `runner:mime:mismatch`
   (`{ path, extension, detected }`) is logged once per file. Other files keep the extension map. Planning key = `sha256(canonicalJson({ task, input, params }))` with each `$ref`
   replaced by its target's planning key and each `$file` by its content hash (deliberately
   excludes `provider`). Artifact key = the same over `{ task, provider, packVersion, input,
   params }`, with `$ref`s replaced by the target's artifact key. The request is the flat task
   request `{ ...input, params }`; the handler estimates it (references unresolved).
   `journal.insertItems` writes the items `queued` with label (`id`, else `<NN>-<task>`), build
   name and artifact key (idempotent per run).
2. **Reuse** — `journal.findDoneArtifact(artifactKey)`: a `done` artifact from any run whose bytes
   are still in the store completes the item at $0, no provider call. A multi-output artifact is
   reused only when the store has every output; otherwise the item builds again.
3. **References** — wait for the item's `$ref` targets to settle; a target that is not `done`
   blocks the item (it stays `queued`, the run ends `paused`). Otherwise each `$ref` becomes the
   target's stored file and each `$file` the local file, as `{ path, mimeType, hash }`.
4. **Claim** — one item per artifact key reaches the provider at a time, across every active
   run. When an item of another run holds the key, this item waits and copies its verdict (see
   [Several runs at once](#several-runs-at-once)).
5. **Admit** — `limits.acquire("{task}/{provider}/default", { signal })`. An abort during the
   wait exits the item cleanly (it stays `queued`). A breaker that refuses the item is waited
   out: the item logs `runner:lane-open` (`{ itemId, lane }`), sleeps, and asks again, so it
   always ends with an `item:*` record. The sleep is the lane's `breakerCooldownMs` while the
   breaker is open, but at least 250 ms, so a cooldown of 0 never spins. While the lane is
   half-open (a probe is in flight and may close the breaker soon) the sleep is 250 ms. A pause
   ends that sleep at once. A slot granted after the run was paused or budget-stopped is released
   at once: a stopped run makes no provider call.
6. **Gate (atomic)** — `journal.gateToDispatching(itemId)`: budget check + dedup + state
   transition in ONE transaction. `"budget"` triggers the graceful budget-stop drain;
   `"duplicate"` releases the lane slot without dispatching (never billed).
7. **Execute** — `registry.resolve(task, provider)` narrowed through `isExecutableHandler()`
   (the runner's single audited dynamic boundary), `journal.recordAttempt`, then either the job
   path (below) or `handler.execute(request, { signal })`.
8. **Classify on error** — `classifyError` maps the thrown error into the journal taxonomy
   (see below); `limits.reportOutcome` feeds the breaker (`"ok"` / `"retryable-error"` only).
   When the drain signal fired and the error carries no provider hint, the attempt ends
   `aborted` and the item stays `dispatching` for `resume()`. A terminal failure also logs
   `runner:item:failed` (`{ itemId, errorClass, message? }`). The message is never written to the
   journal.
9. **Persist** — the result is normalized (`body` / `audio` / `image` / `video` bytes, or `text`),
   `store.put(bytes)` → `journal.commitDone(itemId, { actualCostUsd, artifactKey, contentHash,
   mimeType })`. A result with `images` stores every entry and journals them as `outputs` (see
   [Multi-output items](#multi-output-items)).
10. **Report** — item record, stamped with its `runId`, to the `events()` consumers that follow
    the run; coalesced `run:progress` on the bus.

### Multi-output items

A handler may return `images: { image, mimeType }[]` next to `image` (an image group, such as ark
Seedream with `params.images`). When `images` is present and not empty:

- the runner `store.put`s every entry, in order, and calls `commitDone` with `contentHash` /
  `mimeType` of the first entry and `outputs` = every entry `{ contentHash, mimeType }`. An entry
  with an empty `mimeType` is stored as `application/octet-stream`;
- `item:done` carries `contentHashes`, every output hash in order. A group that came back with one
  image still journals one output and `contentHashes` of length 1, so the caller sees the count;
- a `$ref` to the item resolves to the first output. A `$ref` to the k-th output does not exist yet;
- reuse needs every output in the store; the reused `item:done` carries `contentHashes` too;
- `export` writes one file per output: `<label>.<ext>`, then `<label>-2.<ext>` … `<label>-N.<ext>`,
  each extension from that output's mime type. The item cost is on the first file, 0 on the others.
  An item whose file this export already wrote (an item `x-2` next to a group `x`) is skipped and
  listed in `skipped`, never overwritten;

Without `images` (or with an empty list), nothing changes: one artifact, no `outputs`, no
`contentHashes`.

A retryable failure returns the item to `queued` (`markFailed` with `terminal: false`) and
re-enters admit + gate after the backoff delay, until it settles or exhausts `maxAttempts`.
The lane slot is released before the backoff, so a long `Retry-After` does not hold one of the
lane's concurrency slots. Every wait (retry backoff, breaker cooldown, job poll interval) ends at
once on a pause, and removes its abort listener when it ends, so long runs do not pile listeners
onto the run's signal.

### Provider jobs (`submit` + `poll`)

A handler with both `submit` and `poll` always runs through the job path:

1. `journal.findLiveJob(artifactKey)` — a job still `submitted` for this artifact key, from any
   run (a crash, a pause, a timeout of the caller), is **adopted**: no new submit. An `expired`
   job is adopted too: its first poll decides. Pending or done → it continues. Failed, or unknown
   to the provider (a thrown 4xx) → both rows are marked `failed` and one new job is
   submitted in the same attempt, with its own `jobTimeoutMs`. A content-policy verdict ends the
   item `flagged` with no new submit. An error of our own side (no hint, `invalid-request`,
   `local-failure`) ends the attempt with its class, and an abort pauses the run, both with no
   new submit. A job that expired twice is stuck and is not adopted again.
2. Otherwise `submit()`, then `journal.setAttemptJob(attemptId, { externalId: jobId,
   jobState: "submitted" })` immediately, before any wait.
3. `poll()` every `pollIntervalMs`. A thrown retryable error (5xx / 429 / timeout / network) is a
   transport problem and keeps polling. `{ state: "failed", error }` or a thrown classified error
   (4xx, content policy) marks the job `failed`; the error is classified as usual, and a
   retryable one re-submits on the next attempt. A thrown error of our own side (no hint: a bug;
   `invalid-request` / `local-failure`: the handler's own refusal or failure; not the
   provider's verdict) ends the attempt with its class and marks the job `expired`, so the next
   run adopts it instead of paying again; after two expiries a new job is submitted. `{ state: "done", ... }` marks it `done` and persists
   as above.
4. After `jobTimeoutMs` the job is marked `expired` and the attempt fails with a retryable
   `timeout`. The next attempt adopts the expired job (step 1), so a slow provider is never
   billed twice for one shot.

A poll error with no hint, or tagged `invalid-request` / `local-failure`, marks the job
`expired`, so the next run adopts it: a provider uses this for a lost or rejected key. `kind: "resubmit"` retries like its status says (503 is
`http-5xx`) but never feeds the lane breaker: "submit again" is not a sick lane.

### Several runs at once

One process drives up to `maxActiveRuns` runs at the same time (default 1). Each run keeps its
own runId, abort signal, `maxCostUsd`, totals and status.

- **The cap** — at the cap, `run()` and `resume()` throw
  `[ai] A run is already active: <ids joined ", ">.` and name `maxActiveRuns`. With the default
  of 1 that first line is the same as before concurrent runs.
- **Shared lanes** — lanes are `limits` plugin state keyed by lane, so every run goes through the
  same `limits.acquire(lane)`: concurrency, rpm and the circuit breaker are shared. Two runs on a
  lane with concurrency 2 never have more than 2 provider calls in flight together.
- **No double spend (dedupe)** — the same artifact key in flight in two runs reaches the provider
  once. The first item claims the key; the others wait for its verdict and copy it:
  - `done` — reuse its artifact at cost 0 (`item:done` with `costUsd: 0`). If the bytes are gone
    from the store, treat it as `open`.
  - `flagged` / `failed` — record the same verdict (error class and message) through the gate, with no
    attempt row and no submit: the same request would get the same verdict and cost money.
    `failed` is shared only for a non-retryable class (4xx, `invalid-request`, `local-failure`,
    unknown).
  - `open` — the leader stopped without a final provider verdict (paused, budget stop, gate
    refused, or its attempts ran out on a retryable 5xx / 429 / network / timeout error). The
    leader's item is still `failed`, but the next waiter claims the key and tries for itself: a
    retryable error can pass on a later try. It adopts the leader's live job (`findLiveJob`), so
    a paused leader's job is polled, never submitted again.
- **Abort isolation** — `opts.signal` pauses its own run only. A waiting item of a paused run
  stops waiting and stays `queued`; the other runs keep going.
- **Resume** — `resume()` works while other runs are active; its default target skips them.
  `resume({ runId })` of a run this process drives is refused.
- **Streams** — `events({ runId })` closes after that run ends; `events()` closes when no run is
  active any more. Every record carries its `runId`.
- **`app.stop()`** — pauses every active run and waits for them to end. Each run drains like a
  caller abort and resolves `{ status: "paused" }`, before the journal closes. In-flight provider
  jobs stay `submitted`, so a later `resume()` adopts them instead of paying again.

```ts
const app = createApp({ pluginConfigs: { runner: { maxActiveRuns: 2 } } });
await app.start();

const follow = async (runId: string) => {
  for await (const event of app.runner.events({ runId })) render(runId, event);
};
const [ep1, ep2] = await Promise.all([
  app.runner.run({ files: "ep01/*.moku.yaml", maxCostUsd: 20 }, { onStart: id => void follow(id) }),
  app.runner.run({ files: "ep02/*.moku.yaml", maxCostUsd: 20 }, { onStart: id => void follow(id) })
]);
```

### Retry taxonomy (contractual)

| Error class | Classified from | Outcome |
|-------------|-----------------|---------|
| `http-5xx` | `status >= 500` | Retry with backoff |
| `http-429` | `status === 429` | Retry with backoff (`Retry-After` honored when larger) |
| `timeout` | `kind: "timeout"` | Retry with backoff |
| `network` | `kind: "network"` | Retry with backoff |
| `http-4xx` | `400 <= status < 500` (except 429) | Terminal `failed` |
| `content-policy` | `kind: "content-policy"` | Terminal `flagged`, never re-queued |
| `invalid-request` | `kind: "invalid-request"` | Terminal `failed` after one attempt, no breaker outcome — the handler refuses the request |
| `local-failure` | `kind: "local-failure"` | Terminal `failed` after one attempt, no breaker outcome — the handler's own machine failed (a local tool, a disk) |
| `unknown` | no hint at all (a `TypeError`, a plain `Error`, a string) | Terminal `failed` after one attempt — a programming error must never re-run a paid job |

Handlers (provider plugins, or a consumer's own) steer classification by attaching an optional
structural hint (`ProviderErrorHint`) to their thrown errors:

| Field | Type | Effect |
|-------|------|--------|
| `status` | `number` | HTTP status; classifies when no `kind` names a class |
| `kind` | `"timeout" \| "network" \| "content-policy" \| "resubmit" \| "invalid-request" \| "local-failure"` | `timeout`, `network`, `content-policy`, `invalid-request` and `local-failure` override the status. `resubmit` keeps the status class and stays off the lane breaker |
| `retryAfterMs` | `number` | Provider `Retry-After`, ms; honored when larger than the backoff |
| `publicMessage` | `string` | Text the handler declares safe to show: no keys, no prompts. When non-empty, `item:failed` and the `runner:item:failed` log carry its first two lines (max 300 chars) in place of the `[ai]` rule. Never journaled |

`invalid-request`, `local-failure` and `unknown` are our own side's verdict, not the provider's:
in the job path they mark the job `expired`, never `failed` (see Provider jobs).

```ts
// A studio's own assemble handler refuses a request it cannot run: one attempt,
// item:failed { errorClass: "invalid-request", message: "[studio] Invalid assemble request.\n  Name at least one clip." }.
throw Object.assign(new Error(`[studio] Invalid assemble request: ${detail}`), {
  kind: "invalid-request",
  publicMessage: "[studio] Invalid assemble request.\n  Name at least one clip."
});
```

### The handler protocol

Every registered task/provider handler must satisfy `ExecutableHandler` — validated at runtime,
once, before use (the registry itself never types what it transports):

```ts
type HandlerRequest = Record<string, unknown>; // { ...item.input, params }
type HandlerResult = {
  body?: Uint8Array; audio?: Uint8Array; image?: Uint8Array; video?: Uint8Array; text?: string;
  mimeType?: string; costUsd: number; meta?: Record<string, unknown>;
  images?: { image: Uint8Array; mimeType: string }[]; // every image of a group, in order
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
stored mime type. Labels with `..` or an absolute path are skipped and listed in `skipped`. A
multi-output item writes one file per output: `<label>.<ext>`, `<label>-2.<ext>` …
`<label>-N.<ext>`; the extra files have `label` `<label>-<k>` and `costUsd` 0. An item whose file
this export already wrote is skipped and listed in `skipped`: one export never overwrites its own file.

```ts
const { files } = await app.runner.export({ outDir: "out" });
// [{ label: "e01.s01.h3", path: "/repo/out/ep01/e01.s01.h3.mp4", bytes: 4_812_331, costUsd: 0.3, mimeType: "video/mp4" }]
// a group of 3 keyframes: e01.keys.jpg, e01.keys-2.jpg, e01.keys-3.jpg
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
  matching planned item, `runner:lane-open` while an item waits out an open breaker).

**Dependents:**

- `cliPlugin` — depends on the runner and drives `run`/`resume`/`estimate`/`status`/`events()`
  for the CLI's run, pause (SIGINT → AbortSignal), usage, and budget-stop flows.
- Task plugins (`voiceover`, `translate`, `promptGen`) register their provider handlers with the
  registry; the runner executes them without ever knowing their concrete types.
