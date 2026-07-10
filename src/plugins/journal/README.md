# journal

> Durable SQLite WAL journal — the single source of truth for run/item/attempt state, the atomic budget + dedup gate, and the framework's crash-durability guarantee. Injected as `ctx.journal`.

## Purpose

The journal is the framework's memory. Every build invocation gets one `runs` row; every asset to produce gets one `items` row that moves through a strict state machine (`queued → dispatching → done | failed | flagged`); every provider call gets one `attempts` row recording who was called, when, with what outcome and cost. Because every transition is a committed SQLite write under the strictest durability settings (`WAL` + `synchronous=FULL` + `fullfsync=1`, every write inside `BEGIN IMMEDIATE`), a `kill -9` at any instant loses at most the work of items that were mid-flight — never a byte of recorded progress. That is the enforcement point for the product guarantee `spend <= done_items + dispatching_at_kill`.

It is a **Core plugin** (Complex tier): registered in `createCoreConfig` at Layer 1, so its API surface is available as `ctx.journal` on every regular plugin's context — the `runner` drives the state machine through it, and the `cli` reads progress from it. The journal stores **metadata only** — statuses, attempts, costs, hashes, timestamps, provenance. There are no free-form payload columns, so raw prompts, request/response bodies, or provider payloads are structurally impossible to store here.

## Configuration

Configured under the `journal` key of `pluginConfigs` in `createApp`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | `string` | `".moku/journal.db"` | Path to the journal database file. Parent directories are created on `app.start()`. |
| `checkpointIntervalMs` | `number` | `30_000` | Interval between writer-side `wal_checkpoint(TRUNCATE)` calls, in ms. The timer is `unref()`'d so it never holds the process open. |
| `busyTimeoutMs` | `number` | `5000` | SQLite `busy_timeout`, in ms. Applied to the primary connection and to every short-lived `readSnapshot` connection. |

## Lifecycle

- **`onStart`** — ensures the parent directory exists, opens the runtime-appropriate driver (`bun:sqlite` on Bun, `better-sqlite3` on Node, selected via `typeof Bun`), applies the durability pragma set (`journal_mode=WAL`, `synchronous=FULL`, `fullfsync=1`, `busy_timeout`), creates the schema idempotently, and starts the checkpoint timer.
- **`onStop`** — stops the checkpoint timer, runs a final `wal_checkpoint(TRUNCATE)`, and closes the connection.

Every API method throws if called before `onStart` has run:

```
[ai] Journal is not open.
  Call app.start() before using the journal.
```

## API reference (`ctx.journal.*`)

All write methods run inside `BEGIN IMMEDIATE` transactions. Timestamps are epoch milliseconds.

### Runs

#### `openRun(opts: { glob: string; maxCostUsd?: number }): RunRow`

Creates the single `runs` row for one invocation, with status `"active"`. Omit `maxCostUsd` for an uncapped run (stored as SQL `NULL`).

```ts
const run = ctx.journal.openRun({ glob: "voice/*.yaml", maxCostUsd: 25 });
```

#### `getRun(runId: string): RunRow | undefined`

Looks up one run by id. Returns `undefined` when not found.

```ts
const run = ctx.journal.getRun(runId);
```

#### `latestResumableRun(): RunRow | undefined`

Returns the most recently created run whose status is `"active"`, `"paused"`, or `"budget-stopped"` — the candidate for `resume`. Returns `undefined` when none exists.

```ts
const resumable = ctx.journal.latestResumableRun();
```

#### `setRunStatus(runId: string, status: RunStatus): void`

Sets a run's status. When the new status is terminal (`"done"` or `"failed"`), `finishedAt` is recorded; otherwise it is left unchanged.

```ts
ctx.journal.setRunStatus(run.id, "done");
```

### Items

#### `insertItems(runId: string, items: ItemIntent[]): ItemRow[]`

Inserts planning-time item intents as `"queued"`. Idempotent per `(runId, planningKey)`: re-inserting an existing key is a no-op that returns the existing row unchanged — this is the resume path. Rows are returned in input order.

```ts
const rows = ctx.journal.insertItems(run.id, [
  {
    planningKey: "sha256…",
    buildFile: "voice/intro.yaml",
    task: "voiceover",
    provider: "elevenlabs",
    packVersion: "v2",
    estimatedCostUsd: 0.4
  }
]);
```

#### `requeueDispatching(runId: string): number`

Unconditionally re-queues every `"dispatching"` item of a run (there is no lease/heartbeat mechanism — items stuck in `dispatching` after a crash are simply retried). Returns the number of items requeued. Used by `resume`.

```ts
const requeued = ctx.journal.requeueDispatching(run.id);
```

#### `gateToDispatching(itemId: string): GateResult`

**The atomic gate.** In one `BEGIN IMMEDIATE` transaction it:

1. verifies the item is still `"queued"` — any other status means a duplicate admission attempt → `{ ok: false, reason: "duplicate" }`;
2. verifies the projected spend — `sum(done actual) + sum(dispatching estimated) + this item's estimate` — stays within the run's `maxCostUsd` cap (uncapped runs always pass) → `{ ok: false, reason: "budget" }` when it would exceed;
3. transitions the item `queued → dispatching` and returns `{ ok: true }`.

Race-proof by construction: concurrent gate calls near the cap admit exactly the affordable set. Throws when the item or its run cannot be found. (Cross-item dedup within a run is enforced at insert time by the `UNIQUE (run_id, planning_key)` constraint.)

```ts
const gate = ctx.journal.gateToDispatching(item.id);
if (!gate.ok) {
  // gate.reason is "budget" | "duplicate"
}
```

#### `commitDone(itemId: string, result: { actualCostUsd: number; artifactKey: string; contentHash: string }): void`

Transitions an item `dispatching → done`, recording its realized cost, its artifact identity key, and the CAS content hash of the produced artifact. A no-op if the item is not currently `"dispatching"`.

```ts
ctx.journal.commitDone(item.id, { actualCostUsd: 0.2, artifactKey, contentHash });
```

#### `markFailed(itemId: string, result: { errorClass: ErrorClass; terminal: boolean }): void`

With `terminal: true`, transitions `dispatching → failed`. With `terminal: false`, transitions back to `"queued"` with `attemptCount` incremented — the retry path.

```ts
ctx.journal.markFailed(item.id, { errorClass: "http-5xx", terminal: false });
```

#### `markFlagged(itemId: string): void`

Transitions `dispatching → flagged` — the content-policy terminal state. Flagged items are never re-queued.

```ts
ctx.journal.markFlagged(item.id);
```

### Attempts

#### `recordAttempt(itemId: string, attempt: AttemptStart): number`

Records the start of a provider attempt (`{ provider, account, startedAt }`). Returns the new attempt's numeric id.

```ts
const attemptId = ctx.journal.recordAttempt(item.id, {
  provider: "elevenlabs",
  account: "default",
  startedAt: Date.now()
});
```

#### `finishAttempt(attemptId: number, end: AttemptEnd): void`

Records the end of an attempt: `endedAt`, an `outcome` (`"done" | "retryable-error" | "terminal-error" | "flagged"`), and optionally `errorClass` and `costUsd`.

```ts
ctx.journal.finishAttempt(attemptId, { endedAt: Date.now(), outcome: "done", costUsd: 0.2 });
```

### Reads and aggregates

#### `totals(runId: string): RunTotals`

Aggregate item counts and spend for a run: `{ total, queued, dispatching, done, failed, flagged, spendUsd, estimatedRemainingUsd }`. `spendUsd` sums actual cost of done items; `estimatedRemainingUsd` sums estimates of queued + dispatching items. Used for progress events, budget math, and `moku status`.

```ts
const totals = ctx.journal.totals(run.id);
```

#### `listItems(runId: string, filter?: ItemFilter): ItemRow[]`

Lists a run's items, oldest-updated first. The optional filter narrows by `status`, caps rows with `limit`, or pages with `afterUpdatedAt` (strictly greater than).

```ts
const queued = ctx.journal.listItems(run.id, { status: "queued", limit: 50 });
```

#### `readSnapshot(runId: string): RunSnapshot`

Reads a point-in-time snapshot — `{ run, totals, recentItems }` (up to 20 most recently updated items, newest first) — on its **own short-lived connection**: opens, reads, closes. Designed for a second process (`moku status --follow`) reading the shared journal file while the writer holds the primary connection. Throws when the run is not found.

```ts
const snapshot = ctx.journal.readSnapshot(run.id);
```

#### `checkpoint(): void`

Runs a manual `PRAGMA wal_checkpoint(TRUNCATE)` on the primary connection. The same checkpoint also runs automatically every `checkpointIntervalMs` and once on `onStop`.

```ts
ctx.journal.checkpoint();
```

## Events

None. The journal is a Core plugin — it declares no events, emits nothing, and listens to nothing. Event-driven progress reporting is the `runner` plugin's job, which computes payloads from `ctx.journal.totals()`.

## Usage examples

### Consumer app: overriding journal config

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({
  pluginConfigs: {
    journal: { path: ".moku/my-project.db", checkpointIntervalMs: 10_000 }
  }
});

await app.start(); // opens the journal (directory, driver, pragmas, schema, timer)
await app.stop();  // final checkpoint + close
```

### Custom plugin: driving the full item lifecycle

```ts
import { createPlugin } from "@moku-labs/ai";

export const myPipelinePlugin = createPlugin("myPipeline", {
  api: ctx => ({
    async produceOne(intent: Parameters<typeof ctx.journal.insertItems>[1][number]) {
      const run = ctx.journal.openRun({ glob: "assets/*.yaml", maxCostUsd: 10 });
      const [item] = ctx.journal.insertItems(run.id, [intent]);

      const gate = ctx.journal.gateToDispatching(item.id);
      if (!gate.ok) {
        ctx.log.warn("item blocked", { reason: gate.reason });
        return;
      }

      const attemptId = ctx.journal.recordAttempt(item.id, {
        provider: intent.provider,
        account: "default",
        startedAt: Date.now()
      });

      try {
        const { artifactKey, contentHash, costUsd } = await callProvider(intent);
        ctx.journal.finishAttempt(attemptId, { endedAt: Date.now(), outcome: "done", costUsd });
        ctx.journal.commitDone(item.id, { actualCostUsd: costUsd, artifactKey, contentHash });
        ctx.journal.setRunStatus(run.id, "done");
      } catch {
        ctx.journal.finishAttempt(attemptId, {
          endedAt: Date.now(),
          outcome: "retryable-error",
          errorClass: "http-5xx"
        });
        ctx.journal.markFailed(item.id, { errorClass: "http-5xx", terminal: false });
      }
    }
  })
});
```

### Resuming after a crash

```ts
const run = ctx.journal.latestResumableRun();
if (run) {
  const requeued = ctx.journal.requeueDispatching(run.id);
  ctx.log.info("resuming run", { runId: run.id, requeued });
  // re-insert planned intents (idempotent), then process listItems(run.id, { status: "queued" })
}
```

## Integration

- **Registration** — `journalPlugin` is registered as a Core plugin in `src/config.ts` (`createCoreConfig("ai", …)`), alongside `logPlugin`, `envPlugin`, `storePlugin`, and `limitsPlugin`. Every regular plugin's `ctx` therefore carries a fully typed `ctx.journal`.
- **`runner`** — the primary consumer. Owns run orchestration: `openRun`/`insertItems` at planning, `gateToDispatching` before every dispatch, `recordAttempt`/`finishAttempt` around every provider call, `commitDone`/`markFailed`/`markFlagged` on outcomes, `requeueDispatching` + `latestResumableRun` for resume, `totals`/`setRunStatus` for run completion and budget-stop decisions.
- **`cli`** — reads run state for `status` output; `readSnapshot` backs `moku status --follow` from a second process against the shared journal file.
- **`store`** — the CAS artifact store is the destination of the payloads the journal deliberately does not hold; `commitDone` links the two worlds via `artifactKey` and `contentHash`.

## Internals

- **Schema** (`schema.ts`) — three tables, created idempotently on `onStart`: `runs`, `items` (with `UNIQUE (run_id, planning_key)` and an index on `(run_id, status)`), and `attempts`. Metadata columns only.
- **Driver seam** (`driver/`) — a structural `SqliteDriver` interface with two implementations: `better-sqlite3` on Node, `bun:sqlite` on Bun. Selection is `typeof Bun === "undefined"` in `driver/select.ts`, which also applies the durability pragma set to every opened connection.
- **Durability pragmas** — `journal_mode=WAL`, `synchronous=FULL` (never `NORMAL` — last-commit durability is the product), `fullfsync=1` (macOS `F_FULLFSYNC`; harmless elsewhere), and `busy_timeout`. Every potentially-writing transaction opens with `BEGIN IMMEDIATE`, since `busy_timeout` does not cover read-to-write lock upgrades.
- **Checkpointing** — the writer runs `wal_checkpoint(TRUNCATE)` on a timer to protect against checkpoint starvation from long-lived `--follow` readers.
