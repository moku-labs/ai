# cli

> The `moku` command surface — a mountable command tree plus a post-start `dispatch()` that turns argv into branded output and a ratified exit code.

## Purpose

`cli` is the Complex-tier plugin that puts a terminal in front of the build system. It owns the
seven `moku` commands (`new`, `validate`, `estimate`, `run`, `export`, `status`, `compose`), parses argv with
`node:util`'s `parseArgs`, routes to one command module, and renders everything through the
branded console from `@moku-labs/common/cli` (MC1) — no hand-rolled ANSI escapes, box-drawing, or
spinner animations anywhere in the plugin.

By ratified design (OQ1) the plugin has **no lifecycle** — no `onInit`, `onStart`, `onStop`, and
no state. Dispatch is an ordinary post-start API method: the package `bin` entry (`src/bin.ts`, a
Layer-3 consumer shipped as `dist/bin.mjs` under the `"moku"` bin name) runs
`createApp({})` → `await app.start()` → `await app.cli.dispatch(process.argv.slice(2))` →
`await app.stop()` → `process.exit(code)`. `dispatch()` itself **never calls `process.exit`** —
it returns the code, and the caller owns the process.

## Exit-code contract

Every `dispatch()` call resolves to one of these codes (`EXIT_CODES` in `types.ts`):

| Code | Constant | Meaning |
|------|----------|---------|
| `0` | `ok` | Success |
| `1` | `failure` | Runtime/run failure (also any uncaught command error) |
| `2` | `validation` | Build-file validation error |
| `3` | `usage` | Usage/argument error (unknown command, bad flag, bad flag value) |
| `4` | `paused` | Clean pause (SIGINT drain) |
| `5` | `budgetStop` | Budget stop (`--max-cost` reached) |

An empty or unrecognized command name renders the top-level usage listing (a `moku ai` lockup
banner plus one rail line per command) and returns `3`.

## Commands

### `moku new [name]`

Writes a starter build file and its JSON Schema. No flags.

- Renders `buildfile.template({ name })` to `<name>.moku.yaml` (`name` defaults to `"build"`).
- Parses the template's first-line `# yaml-language-server: $schema=<path>` modeline and
  writes/refreshes `buildfile.jsonSchema()` at that path (creating parent directories), so the
  emitted modeline always resolves — without duplicating `buildfile`'s `schemaPath` config here.
- Refuses to overwrite an existing build file (exit `1`).

```bash
moku new demo
```

```text
✔ wrote demo.moku.yaml
✔ wrote .moku/schema.json
```

Exit: `0` on success, `1` on overwrite refusal.

### `moku validate [glob]`

Validates build files against the schema via `buildfile.loadGlob(glob)` (the configured default
glob when the positional is omitted). Renders one OK check row per compiled build file;
`loadGlob` rejects on the first invalid file (or an empty match), rendered as a single failing
row. No flags.

```bash
moku validate "**/*.moku.yaml"
```

```text
✔ intro.moku.yaml
✔ outro.moku.yaml
```

Exit: `0` when every matched file validates, else `2`.

### `moku estimate [glob]`

Estimates the cost of matched build files via `runner.estimate` — a per-task/provider cost
breakdown plus its total, rendered as rail lines in a branded box. No flags.

```bash
moku estimate
```

```text
┌──────────────────────────────────────────────┐
│   voiceover/elevenlabs × 12 ······· $0.4800  │
│   translate/openai × 12 ··········· $0.0240  │
│   total ··························· $0.5040  │
└──────────────────────────────────────────────┘
```

Exit: `0`.

### `moku run [glob] [--max-cost <usd>] [--dry-run] [--out <dir>]`

Runs matched build files via `runner.run` with a SIGINT-wired `AbortSignal`, then exports every
done artifact to `<out>/<build>/<label>.<ext>` and prints one line per file (`label  $cost  path`).

| Flag | Type | Description |
|------|------|-------------|
| `--max-cost <usd>` | string | Maximum spend in USD before the run stops. A non-numeric or negative value is a usage error (exit `3`). |
| `--dry-run` | boolean | Estimate without executing. |
| `--out <dir>` | string | Export directory. Default `out`. |

Progress is rendered by draining `runner.events()` — the event stream is opened synchronously
right after `runner.run()` is called, which is required to observe the run's active subscription
window. Coalesced `"progress"` events render a spinner-prefixed line (spinner only in color
mode); the authoritative `"terminal"` record renders a final branded box.

```bash
moku run "assets/**/*.moku.yaml" --max-cost 5
```

```text
⠋ 3/12 done · $0.1240 spent
⠙ 7/12 done · $0.2903 spent
┌────────────────────┐
│ status   done      │
│ done     12/12     │
│ failed   0         │
│ flagged  0         │
│ spend    $0.5012   │
└────────────────────┘
```

`--dry-run` never activates the event stream (`runner.run` returns its estimate before
subscribing an active run); the planned-item count and estimated cost render directly from the
returned totals:

```bash
moku run --dry-run
```

```text
┌──────────────────────────────┐
│ dry-run  12 item(s) planned  │
│ estimate $0.5040             │
└──────────────────────────────┘
```

Exit: the run's terminal status mapped to the contract — `done`→`0`, `failed`→`1`, `paused`→`4`,
`budget-stopped`→`5`; bad `--max-cost`→`3`.

### `moku export [runId] [--out <dir>]`

Copies a run's done artifacts (default: the newest run) to `<out>/<build>/<label>.<ext>` via
`runner.export`. The label is the build item's `id`, else `<NN>-<task>`; the extension comes from
the stored mime type.

```bash
moku export --out out
```

Exit: `0`; `1` when the run does not exist.

### `moku status [runId] [--follow]`

Reports the status of a run (`runId` defaults to the latest run).

| Flag | Type | Description |
|------|------|-------------|
| `--follow` | boolean | Poll for updates until the run finishes. |

Without `--follow`, renders one `runner.status(runId)` snapshot box. With `--follow`, polls
`journal.readSnapshot(runId)` on a 1-second interval — each read a short-lived, one-shot call,
**never** one held-open connection (the WAL checkpoint-starvation mitigation, contractual) —
rendering the snapshot every tick until the run reaches a terminal status (`done`, `failed`,
`paused`, `budget-stopped`).

```bash
moku status run-42
```

```text
┌──────────────────────┐
│ run      run-42      │
│ status   running     │
│ done     7/12        │
│ failed   0           │
│ flagged  1           │
│ spend    $0.2903     │
└──────────────────────┘
```

Exit: `0`.

### `moku compose "<prompt>" [--emit build|script] [--out <path>]`

Generates a build file from a natural-language prompt via `compose.compose`, with SIGINT wired to
an abort signal so a clean pause is possible mid-generation.

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--emit <format>` | string | `"build"` | Output format: `"build"` or `"script"`. Any other value is a usage error (exit `3`). |
| `--out <path>` | string | — | File path to write the emitted text to. Omit to print to stdout. |

```bash
moku compose "narrate a sunset in 3 languages" --out sunset.moku.yaml
```

```text
✔ wrote sunset.moku.yaml
cost: $0.0132
```

Exit: `0` on success, `3` for a missing prompt or bad `--emit`, `2` when compose exhausted every
repair attempt without producing a valid build file, else `1`.

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `plain` | `boolean` | `false` | Disable ANSI color/spinners. Plain mode is also auto-enabled when stdout is not a TTY or `NO_COLOR` is set in the environment (read via `ctx.env`, MC3). |

## API reference (`app.cli`)

### `dispatch(argv: string[]): Promise<number>`

Parses argv, routes to a command module, renders via the branded console, and translates the
outcome to the exit-code contract. `argv` excludes the node/script prefix (e.g.
`["run", "--dry-run"]`). Flags are parsed per command with `node:util`'s `parseArgs`
(`strict: true`, positionals allowed); kebab-case flag names are normalized to camelCase keys for
the handler (`--max-cost` → `maxCost`), and boolean flags are recorded as the literal `"true"`.
Any `parseArgs` failure (unknown flag, missing string value) is a usage error (exit `3`), and any
uncaught handler error is rendered and mapped to exit `1`. Never calls `process.exit`.

### `commands(): CommandTree`

The mountable command tree — `{ name: "ai", description, commands: [{ name, description, flags }] }`
with flags flattened to `Record<flagName, description>` — exported for a future umbrella CLI to
remount under `moku ai <cmd>`.

Supporting types (`CommandTree`, `CommandContext`, `CommandDefinition`, `CommandFlags`,
`CommandFlagSpec`, `CliApi`, `Config`) and the `EXIT_CODES` constant are exported from the
framework entry under the `Cli` namespace (`import { Cli } from "@moku-labs/ai"`).

## Events

None. The plugin emits nothing and listens to nothing on the event bus — `run`'s progress
rendering consumes `runner.events()`, an `AsyncIterable<RunEvent>`, not bus hooks.

## SIGINT wiring

`run` and `compose` execute through the shared `runWithAbort` helper on `CommandContext`:

- The first Ctrl-C aborts the operation's `AbortSignal` — a clean pause via drain (exit `4` when
  the run reports `paused`).
- The listener is installed with `process.once`, so after it fires there is no registered handler
  left: a second Ctrl-C falls through to Node's default SIGINT behavior (immediate process exit).
  Durability makes that safe — and it is never a `process.exit` call from this plugin.
- The listener is always removed once the operation settles.

## Usage examples

### Shell

```bash
# Scaffold, validate, price, run
moku new demo
moku validate
moku estimate
moku run --max-cost 10

# Watch a run from another terminal
moku status --follow

# Generate a build file from a prompt
moku compose "voiceover for every scene in scenes/" --emit build --out scenes.moku.yaml
```

### TypeScript (programmatic dispatch)

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({});
await app.start();

const code = await app.cli.dispatch(["run", "--dry-run"]);

await app.stop();
process.exit(code);
```

### TypeScript (configuration + command tree)

```ts
import { Cli, createApp } from "@moku-labs/ai";

const app = createApp({ pluginConfigs: { cli: { plain: true } } });
await app.start();

// Introspect the mountable tree (for an umbrella CLI).
for (const command of app.cli.commands().commands) {
  console.log(command.name, "—", command.description);
}

const code = await app.cli.dispatch(["validate"]);
if (code !== Cli.EXIT_CODES.ok) {
  // handle validation failure
}

await app.stop();
```

## Integration

**Dependencies** (declared via `depends`, resolved once per `dispatch()` into the shared
`CommandContext` — commands never touch the plugin `ctx` directly and never import each other):

- `runnerPlugin` — `run` / `estimate` / `status` / `events` (drives `run`, `estimate`, `status`).
- `buildfilePlugin` — `template` / `loadGlob` / `jsonSchema` (drives `new`, `validate`).
- `composePlugin` — `compose` (drives `compose`).
- Core-plugin APIs: `ctx.journal.readSnapshot` (`status --follow`'s short-lived polling reads),
  `ctx.log` (structured diagnostics, MC2), `ctx.env` (`NO_COLOR` detection, MC3).

**Rendering** — `render.ts` is the MC1 seam: it composes one `BrandConsole` via
`createBrandConsole({ color: !plain })` from `@moku-labs/common/cli`, and every command renders
exclusively through it (`lockup`, `heading`, `box`, `railLine`, `check`, `info`, `error`, `line`),
with `spinnerFrameAt` supplying `run`'s progress spinner frames. Plain mode
(`config.plain` || non-TTY stdout || `NO_COLOR`) disables color and spinners.

**Process ownership** — the `"moku"` bin (`package.json` `"bin": { "moku": "./dist/bin.mjs" }`,
built from `src/bin.ts`) is the only place `process.exit` is called. It imports only the
framework's public entry, making it a plain Layer-3 consumer of `app.cli.dispatch`.

**File layout** — `index.ts` (plugin definition), `types.ts` (types + `EXIT_CODES`), `api.ts`
(registry, argv parsing, dispatch, `CommandContext` assembly), `render.ts` (branded-console
composition), and one module per command under `commands/`. No `state.ts` — the plugin is
stateless.
