# cli

> Complex plugin — the `moku` command surface: a mountable command tree + a post-start `dispatch()` API returning the exit-code contract.

`cli` has **no lifecycle** (ratified OQ1): `src/bin.ts` (the package `"bin"` entry, a Layer-3
consumer) calls `createApp()` → `await app.start()` → `await app.cli.dispatch(argv)` → `await
app.stop()` → `process.exit(code)`. `dispatch()` never calls `process.exit` itself — the caller
owns the process. All rendering goes through `@moku-labs/common/cli` (MC1): `createBrandConsole`,
`box`, `spinnerFrameAt` — no hand-rolled ANSI escapes, box-drawing, or spinner animations anywhere
in this plugin.

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `plain` | `boolean` | `false` | Disable ANSI color/spinners. Also auto-disabled when stdout is not a TTY, or `NO_COLOR` is set (read via `ctx.env`, MC3). |

## Exit-code contract

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Runtime/run failure |
| `2` | Build-file validation error |
| `3` | Usage/argument error |
| `4` | Clean pause (SIGINT drain) |
| `5` | Budget stop |

## Commands

| Command | Usage | Notes |
|---------|-------|-------|
| `new` | `moku new [name]` | Writes `<name>.moku.yaml` from `buildfile.template()` and refreshes the JSON Schema file the emitted modeline points at. Refuses to overwrite an existing build file (exit `1`). `name` defaults to `"build"`. |
| `validate` | `moku validate [glob]` | `buildfile.loadGlob` against `glob` (or the configured default); renders one OK row per compiled build file, or a failing row on the first invalid file. Exit `0` or `2`. |
| `estimate` | `moku estimate [glob]` | `runner.estimate`; per-task/provider cost breakdown + total in a branded box. Exit `0`. |
| `run` | `moku run [glob] [--max-cost <usd>] [--dry-run]` | `runner.run` with a SIGINT-wired signal; renders coalesced progress from `runner.events()`. `--dry-run` renders its item-count/estimate summary directly from the returned result (the event stream stays empty for dry runs). Maps the result's terminal status to the exit-code contract (`done`→0, `failed`→1, `paused`→4, `budget-stopped`→5). A non-numeric/negative `--max-cost` is a usage error (exit `3`). |
| `status` | `moku status [runId] [--follow]` | `runner.status` snapshot table. `--follow` polls `journal.readSnapshot` on a 1s interval — each read is short-lived (NEVER one held-open connection, the WAL checkpoint-starvation mitigation) — until the run reaches a terminal status. Exit `0`. |
| `compose` | `moku compose "<prompt>" [--emit build\|script] [--out <path>]` | `compose.compose`; writes the emitted file, or prints to stdout when `--out` is omitted. Exit `0` / `1` / `2` (invalid after every repair attempt). |

## API

### `dispatch(argv): Promise<number>`
Parses `argv` (`node:util`'s `parseArgs`), routes to the matching command module, renders through
the branded console, and returns the exit code. `argv` excludes the node/script prefix (e.g.
`["run", "--dry-run"]`). Never calls `process.exit`.

### `commands(): CommandTree`
The mountable command tree (name, description, flags per command) — exported for a future
umbrella CLI to remount under `moku ai <cmd>`.

## SIGINT wiring

`run` and `compose` run through a shared `runWithAbort` helper: the first Ctrl-C aborts the
operation's `AbortSignal` (a clean pause via drain); because the listener is installed with
`process.once`, a second Ctrl-C has no registered handler left and falls through to Node's default
SIGINT behavior (immediate process exit) — durability makes that safe, and `cli` never calls
`process.exit` itself.

## Dependencies

- `runnerPlugin` — `run`/`resume`/`estimate`/`status`/`events`.
- `buildfilePlugin` — `template`/`loadGlob`/`jsonSchema`.
- `composePlugin` — `compose`.
- Core: `ctx.journal.readSnapshot` (`status --follow`), `ctx.log`, `ctx.env` (`NO_COLOR`).

## Usage

```typescript
// bin.ts (Layer-3 consumer — not part of this plugin)
const app = createApp();
await app.start();
const code = await app.cli.dispatch(process.argv.slice(2));
await app.stop();
process.exit(code);
```
