# compose

> Natural-language prompt → validated build file, emitted as YAML or a `defineBuild()` script — via the promptGen facade and the buildfile IR.

## Purpose

`compose` is the framework's authoring assistant: it turns a plain-English description of what
you want built ("narrate a two-line intro, then translate it to Spanish") into a real, valid
build file that `runner` can execute. It is a **stateless orchestrator** of two required APIs —
`promptGen` produces candidate YAML from an LLM, and `buildfile` validates every candidate
through its zod IR before anything is returned. The core guarantee follows directly from that
pipeline: **compose can never hand back an invalid build file.** When a candidate fails
validation, compose re-prompts the model with the exact validation issue and the previous
output, bounded by `maxRepairAttempts` additional attempts, before giving up with a pinned
error.

The plugin exists so build files don't have to be written by hand to get started. It sits
between the IR layer (`buildfile`) and the command surface (`cli`): `compose()` itself never
writes files — it returns the validated spec plus its emitted text, and the `moku compose` CLI
command (or your own code) decides where that text goes. Generation is reached exclusively
through the `promptGen` facade, never through `registry` directly — the audited registry cast
belongs to the owning task plugin, not to compose (a ratified design decision).

## Configuration

Configured under the `compose` key of `createApp({ pluginConfigs })`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `provider` | `string` | `"openai"` | Provider passed to `promptGen.generate` for every attempt. |
| `maxRepairAttempts` | `number` | `2` | Maximum **additional** regeneration attempts when model output fails IR validation. Total attempts = `1 + maxRepairAttempts`. |

```ts
const app = createApp({
  pluginConfigs: {
    compose: { provider: "openai", maxRepairAttempts: 3 }
  }
});
```

## API reference

The plugin exposes a single method as `app.compose` (or `ctx.require(composePlugin)` from a
dependent plugin).

### `compose(opts): Promise<ComposeResult>`

Generates a build file from a natural-language prompt.

```ts
compose(opts: {
  prompt: string;
  emit: "build" | "script";
  name?: string;
  signal?: AbortSignal;
}): Promise<{ spec: BuildSpec; text: string; costUsd: number }>;
```

**Parameters**

| Param | Type | Description |
|-------|------|-------------|
| `opts.prompt` | `string` | The natural-language build description. |
| `opts.emit` | `"build" \| "script"` | `"build"` emits YAML build-file text; `"script"` emits a `defineBuild()` TypeScript module. |
| `opts.name` | `string?` | Overrides the generated spec's `name` field (applied after validation — a plain string override never invalidates a validated spec). |
| `opts.signal` | `AbortSignal?` | Forwarded to every `promptGen.generate` call, so an in-flight generation (including repair attempts) can be aborted. |

**Returns** — a `ComposeResult`:

| Field | Type | Description |
|-------|------|-------------|
| `spec` | `BuildSpec` | The validated spec — always the one that passed `buildfile.compile`. |
| `text` | `string` | The emitted text, per `opts.emit` (YAML build file or `defineBuild()` script). |
| `costUsd` | `number` | Total cost accumulated across **every** `promptGen.generate` call the repair loop made — failed attempts count too. |

**Pipeline**

1. Build a system prompt embedding `buildfile.jsonSchema()` plus per-task input documentation
   (`voiceover`, `translate`, `prompt-gen` input shapes).
2. Call `promptGen.generate({ prompt, system }, { provider, signal })`.
3. Strip a defensive markdown code fence (` ```yaml ... ``` `) from the model output, if present.
4. Validate through `buildfile.compile({ text, lang: "yaml" })` (the zod IR).
5. On failure, re-prompt with the original request, the previous output, and the validation
   issue — up to `maxRepairAttempts` additional times.
6. On success, apply the `opts.name` override (if given) and emit:
   - `"build"` → YAML text with the yaml-language-server modeline and `$schema:` key — the same
     conventions `buildfile.template()` uses for `moku new`. The schema path is derived from
     `buildfile.template()`'s modeline, so compose always points at whatever schema path
     `buildfile` is actually configured with.
   - `"script"` → a TypeScript module: `import { defineBuild } from "@moku-labs/ai";` followed
     by `export default defineBuild({ ...spec });`.

**Throws** — when every attempt fails IR validation, the pinned two-line error:

```
[ai] Compose could not produce a valid build file after <n> attempts.
  Refine the prompt or write the build file manually with "moku new".
```

(`<n>` is the total attempt count, i.e. `1 + maxRepairAttempts`.)

**Example**

```ts
const { spec, text, costUsd } = await app.compose.compose({
  prompt: "Narrate a greeting in English, then translate it to Spanish.",
  emit: "build"
});

console.log(spec.name); // model-chosen name
console.log(text); // "# yaml-language-server: $schema=...\n$schema: ...\nversion: 1\n..."
console.log(costUsd); // e.g. 0.0004
```

## Events

None. `compose` neither emits nor listens to any events — it is pure request/response
orchestration over its two required APIs.

## Usage examples

### Generate a YAML build file

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({
  pluginConfigs: { compose: { provider: "openai", maxRepairAttempts: 2 } }
});
await app.start();

const { text } = await app.compose.compose({
  prompt: "A voiceover of a two-line product intro, plus a French translation of it.",
  emit: "build"
});

// compose never writes files — persisting the text is the caller's job.
await Bun.write("intro.moku.yaml", text);

await app.stop();
```

### Generate a typed `defineBuild()` script with a fixed name

```ts
const { spec, text } = await app.compose.compose({
  prompt: "Generate an image prompt for a neon city skyline.",
  emit: "script",
  name: "neon-city"
});

console.log(spec.name); // "neon-city" — override applied after validation
await Bun.write("neon-city.build.ts", text);
```

### Abortable generation with cost reporting

```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 30_000);

try {
  const { text, costUsd } = await app.compose.compose({
    prompt: "Narrate a sunset scene.",
    emit: "build",
    signal: controller.signal
  });
  console.log(`generated for $${costUsd.toFixed(4)}`);
  console.log(text);
} finally {
  clearTimeout(timer);
}
```

### Handling repair exhaustion

```ts
try {
  await app.compose.compose({ prompt: "something the model keeps getting wrong", emit: "build" });
} catch (error) {
  if (error instanceof Error && error.message.includes("could not produce a valid build file")) {
    // Every attempt failed zod validation — refine the prompt or write the file by hand.
  }
  throw error;
}
```

Consumer-facing types are exported under the `Compose` namespace:

```ts
import type { Compose } from "@moku-labs/ai";

type Result = Compose.ComposeResult; // { spec: BuildSpec; text: string; costUsd: number }
type Api = Compose.ComposeApi;
```

## Integration

`compose` is registered in the framework's plugin chain (`src/index.ts`) after its dependencies
and before `cli`. Registration: `createPlugin("compose", { depends: [buildfilePlugin,
promptGenPlugin], config, api: createComposeApi })`.

### Dependencies

- **`buildfile`** — three call sites:
  - `jsonSchema()` — embedded verbatim in the system prompt so the model targets the real IR
    schema.
  - `compile({ text, lang: "yaml" })` — every candidate must pass this zod validation before it
    can be returned; its error message becomes the repair prompt's issue text.
  - `template({ name })` — the rendered template's first line (the yaml-language-server
    modeline) is parsed to derive the schema path used in emitted YAML, so compose never
    duplicates buildfile's schema-path configuration onto its own `Config`. If the template
    ever stops starting with that modeline, compose throws a pinned two-line error telling you
    so.
- **`promptGen`** — `generate({ prompt, system }, { provider, signal })` for all LLM output.
  This is the **facade edge**: compose deliberately does not depend on (or `ctx.require`)
  `registry`. Reaching prompt generation exclusively through the `promptGen` facade keeps the
  one-audited-cast-per-task rule intact — its `ComposeRequire` type is narrowed to exactly
  `buildfilePlugin` and `promptGenPlugin`, so requiring anything else is a type error.

### Dependents

- **`cli`** — the `moku compose "<prompt>" [--emit build|script] [--out <path>]` command calls
  `compose.compose` with a SIGINT-wired abort signal, writes the returned text to `--out` (or
  prints it to stdout), and reports `costUsd`. Exit codes: `0` ok, `1` usage (missing prompt /
  bad `--emit`), validation exit code when the repair loop exhausted, generic failure otherwise.
  This split is by design: compose produces text, the CLI persists it.

### Lifecycle and state

None. compose declares no `createState`, no lifecycle hooks (`onInit`/`onStart`/`onStop`), and
holds no resources — it is safe to call from the moment the app is constructed and started.
