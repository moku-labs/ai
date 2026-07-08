# journal

> Core·Complex plugin — SQLite WAL journal: runs/items/attempts state machine, atomic budget+dedup gate, durability pragmas

The durable SQLite WAL journal — the single source of truth for run/item/attempt state and the
enforcement point for the durability guarantee (`spend <= done_items + dispatching_at_kill`). Owns
the `queued → dispatching → done | failed | flagged` item state machine, the atomic budget + cross-
build dedup gate (one `BEGIN IMMEDIATE` transaction), per-invocation `runs`-row scoping, and WAL
checkpoint scheduling. Injected as `ctx.journal` on every regular plugin's context.

Metadata only — status, attempts, costs, hashes, timestamps, provenance. Never raw request/response
bodies, prompts, or provider payloads; the API surface makes storing bodies structurally impossible.

## API

`ctx.journal.*`:

- `openRun(opts: { glob: string; maxCostUsd?: number }): RunRow` — creates the single `runs` row for one invocation.
- `getRun(runId: string): RunRow | undefined`
- `latestResumableRun(): RunRow | undefined` — most recent run with status `active`/`paused`/`budget-stopped`, for `resume`.
- `insertItems(runId: string, items: ItemIntent[]): ItemRow[]` — idempotent per `(run_id, planning_key)`; re-inserting an existing key is a no-op returning the existing row.
- `requeueDispatching(runId: string): number` — unconditionally re-queues every `dispatching` item of a run (no lease/heartbeat); returns the count.
- `gateToDispatching(itemId: string): GateResult` — the atomic budget + dedup gate. One `BEGIN IMMEDIATE` transaction that verifies the item is still queued, verifies the projected spend stays within budget, then transitions `queued → dispatching`.
- `recordAttempt(itemId: string, attempt: AttemptStart): number` — returns the new attempt id.
- `finishAttempt(attemptId: number, end: AttemptEnd): void`
- `commitDone(itemId: string, result: { actualCostUsd: number; artifactKey: string; contentHash: string }): void` — `dispatching → done`.
- `markFailed(itemId: string, result: { errorClass: ErrorClass; terminal: boolean }): void` — `dispatching → failed` (terminal) or back to `queued` (retryable, `attempt_count++`).
- `markFlagged(itemId: string): void` — `dispatching → flagged` (content-policy terminal state; never re-queued).
- `setRunStatus(runId: string, status: RunStatus): void`
- `totals(runId: string): RunTotals` — aggregates for progress events, budget math, `moku status`.
- `listItems(runId: string, filter?: ItemFilter): ItemRow[]`
- `readSnapshot(runId: string): RunSnapshot` — short-lived read connection helper for a second process (`moku status --follow`): opens, reads, closes.
- `checkpoint(): void` — manual `wal_checkpoint(TRUNCATE)` (also runs on the `onStart` timer).

All write methods run inside `BEGIN IMMEDIATE` transactions. Every method throws
`[ai] Journal is not open.\n  Call app.start() before using the journal.` if invoked before
`app.start()`.

## Configuration

```ts
type Config = {
  /** Path to the journal database file. Default: ".moku/journal.db" (parent dirs created). */
  path: string;
  /** Interval between writer-side wal_checkpoint(TRUNCATE) calls, ms. Default: 30_000. */
  checkpointIntervalMs: number;
  /** SQLite busy_timeout, ms. Default: 5_000. */
  busyTimeoutMs: number;
};
```

## Durability pragmas

Applied on every opened connection (`driver/select.ts`):

- `journal_mode = WAL`
- `synchronous = FULL` (never `NORMAL`)
- `fullfsync = 1` (maps to `F_FULLFSYNC` on macOS; harmless elsewhere)
- `busy_timeout` — set, and every write transaction opens with `BEGIN IMMEDIATE` (busy_timeout alone
  does not cover read→write lock upgrades)

## Driver seam

An internal `SqliteDriver` structural interface (`driver/types.ts`) with two implementations:
`better-sqlite3` on Node (`driver/better-sqlite3.ts`) and `bun:sqlite` on Bun
(`driver/bun-sqlite.ts`, loaded lazily via `require` so the Bun-only built-in is never statically
resolved under Node). Runtime selection happens in `driver/select.ts` via `typeof Bun !== "undefined"`.
