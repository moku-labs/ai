# buildfile

> The build-file front-end: YAML and `defineBuild()` TypeScript sources compiled through one zod schema into the validated `BuildSpec` IR.

## Purpose

Every build in `@moku-labs/ai` starts as a declarative build file. The `buildfile` plugin is the
single front door for those files: it parses `*.moku.yaml` (the canonical authoring format) and
`defineBuild()` TypeScript modules, validates them through one zod schema (`schema.ts`), and hands
downstream plugins a normalized intermediate representation — the `BuildSpec`. The runner runs it,
compose generates it, and the CLI scaffolds and validates it, but none of them ever parse a build
file themselves.

The design constraint is "one schema, zero drift": the `BuildSpec`/`BuildItem` TypeScript types are
`z.infer` of the zod objects, the JSON Schema handed to editors is generated from the same zod
objects via `z.toJSONSchema`, and the `moku new` starter template is rendered against that schema
path. The runtime validator, the static types, and editor autocomplete can never disagree. The
plugin is a stateless pure compiler — no state, no lifecycle hooks, no events — and it deliberately
does NOT consult the `registry` plugin: provider existence is checked at dispatch by the runner, so
`moku validate` works offline without any providers configured.

## Configuration

Registered as `buildfile`; override via `createApp({ pluginConfigs: { buildfile: { ... } } })`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `defaultGlob` | `string` | `"**/*.moku.yaml"` | Glob used when `loadGlob` (and therefore a run/validate) is invoked without an explicit pattern. |
| `schemaPath` | `string` | `".moku/build.schema.json"` | Where `moku new` writes the generated JSON Schema, and the path the template's modeline and `$schema:` key point at. |

## API reference

The plugin exposes its API as `app.buildfile` (consumer apps) / `ctx.require(buildfilePlugin)`
(dependent plugins).

### `compile(source: BuildfileSource): Promise<CompiledBuild>`

Parses and validates one source into the IR.

- **Params:** `source` — `{ path: string }` (a file path, dispatched by extension: `.ts` is
  dynamically imported and its `default` export used — it must be a `defineBuild()` result;
  anything else is read as YAML) or `{ text: string; lang: "yaml" }` (inline YAML text).
- **Returns:** `CompiledBuild` — `{ file, spec }`, where `file` is the source path or the synthetic
  label `"<inline>"`, and `spec` is the validated `BuildSpec`. If the spec declares `itemsFrom`,
  that NDJSON file is read (resolved relative to the build file's directory, or `process.cwd()`
  for inline text) and its items are appended to `spec.items` at compile time.
- **Throws:** the pinned two-line error on any validation failure:

  ```
  [ai] Build file "<label>" is invalid.
    <first zod issue dotted path>: <message>.
  ```

  Malformed or invalid `itemsFrom` lines report their 1-based line number
  (`itemsFrom line <n>: ...`) in the same format.

```ts
const { file, spec } = await app.buildfile.compile({ path: "build.moku.yaml" });
const inline = await app.buildfile.compile({ text: "version: 1\nname: demo\nitems: []\n", lang: "yaml" });
```

### `loadGlob(pattern?: string): Promise<CompiledBuild[]>`

Expands a glob and compiles every match.

- **Params:** `pattern` — glob pattern; defaults to `config.defaultGlob`.
- **Returns:** one `CompiledBuild` per matched file, in deterministic (sorted ascending) path
  order — glob enumeration order is not stable across platforms, so matches are sorted first.
- **Throws:** when nothing matches, a two-line error suggesting the fix:

  ```
  [ai] No build files matched "<pattern>".
    Run "moku new" to create one.
  ```

  Any individual file that fails validation rejects the whole call with its `compile` error.

```ts
const builds = await app.buildfile.loadGlob("builds/**/*.moku.yaml");
const defaults = await app.buildfile.loadGlob(); // uses config.defaultGlob
```

### `jsonSchema(): Record<string, unknown>`

- **Returns:** the JSON Schema object generated from `buildSpecSchema` via `z.toJSONSchema` —
  what `moku new` writes to `config.schemaPath` and what compose embeds in its LLM system prompt.
- **Throws:** nothing.

```ts
const schema = app.buildfile.jsonSchema();
await writeFile(".moku/build.schema.json", JSON.stringify(schema, undefined, 2), "utf8");
```

### `template(opts: { name: string }): string`

Renders the starter build-file text for `moku new`.

- **Params:** `opts.name` — the `name:` field of the generated build file.
- **Returns:** the starter text: the yaml-language-server modeline
  (`# yaml-language-server: $schema=<schemaPath>`) AND the `$schema:` key — both are emitted
  because the literal `$schema:` key alone does NOT activate editor autocomplete; only the
  modeline comment does — followed by a minimal valid spec and one commented example item per
  M0 task (`voiceover`, `translate`, `prompt-gen`). The rendered text is itself a valid,
  compilable build file.
- **Throws:** nothing.

```ts
const text = app.buildfile.template({ name: "demo" });
// "# yaml-language-server: $schema=.moku/build.schema.json\n$schema: ..."
```

### Standalone helper: `defineBuild(spec: BuildSpec): BuildSpec`

Exported alongside the plugin and re-exported from `"@moku-labs/ai"`. A pure factory — no ctx, no
lifecycle, no side effects. Validates the literal through the exact zod schema the YAML loader
uses, so a TS build file and a `*.moku.yaml` file can never drift; it is also the typed generation
target `compose --emit script` writes against.

- **Params:** `spec` — the build spec literal.
- **Returns:** the same spec, validated by the schema.
- **Throws:** `[ai] Build file "<inline>" is invalid.` (two-line pinned format) when validation fails.

```ts
import { defineBuild } from "@moku-labs/ai";

export default defineBuild({
  version: 1,
  name: "demo",
  items: [{ task: "voiceover", input: { text: "Hello, world!", voice: "en-US-1" } }]
});
```

## Build file format

The zod schema in `schema.ts` is the single source of truth; `BuildSpec` and `BuildItem` are
`z.infer` of it. Unknown top-level keys (such as the `$schema:` convenience key the template
emits) are stripped by zod, not rejected.

### `BuildSpec` (top level)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | `1` (literal) | yes | Format version; only `1` is accepted. |
| `name` | `string` | yes | Human-readable build name. |
| `defaults` | `{ provider?: string; maxAttempts?: number }` | no | Per-build defaults applied by the runner at dispatch. |
| `items` | `BuildItem[]` | yes | The build's task invocations (may be `[]`). |
| `itemsFrom` | `string` | no | Path to an NDJSON file (one `BuildItem` JSON object per line, blank lines skipped), resolved relative to the build file, appended to `items` at compile time. |

### `BuildItem` (one task invocation)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `task` | `string` | yes | Task name — `"voiceover"`, `"translate"`, `"prompt-gen"`, or any registered task (open set; existence is checked by the runner, not here). |
| `id` | `string` | no | Human label; not identity. |
| `provider` | `string` | no | Provider override; the runner falls back to `defaults.provider`, else the task's first registered provider. |
| `input` | `Record<string, unknown>` | yes | Task-specific request payload; the task plugin validates it at dispatch. |
| `params` | `Record<string, unknown>` | no | Output-relevant parameters — part of the runner's planning key. |
| `pack` | `{ name: string; version: string }` | no | Asset-pack association. |

### Annotated example

```yaml
# yaml-language-server: $schema=.moku/build.schema.json   # activates editor autocomplete
$schema: .moku/build.schema.json                          # convenience key; ignored by the validator
version: 1                                                # must be the literal 1
name: "launch-assets"
defaults:
  provider: elevenlabs                                    # used when an item omits `provider`
  maxAttempts: 3
items:
  - task: voiceover
    id: intro-line                                        # optional human label
    input:
      text: "Hello, world!"
      voice: "en-US-1"
  - task: translate
    provider: openai                                      # per-item provider override
    input:
      text: "Hello, world!"
      targetLang: "es"
    params:
      formality: high                                     # part of the planning key
itemsFrom: extra-items.ndjson                             # each line: {"task":"...","input":{...}}
```

The equivalent TypeScript form is a module whose default export is a `defineBuild()` result (see
the helper above); `compile({ path: "build.moku.ts" })` imports it and validates the same way.

## Events

None. The plugin emits nothing and listens to nothing — it is a pure compiler. It also declares no
plugin dependencies.

## Usage examples

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({
  pluginConfigs: {
    buildfile: { defaultGlob: "builds/**/*.moku.yaml", schemaPath: ".moku/build.schema.json" }
  }
});
await app.start();

// Compile one build file (YAML or TS, by extension)
const { spec } = await app.buildfile.compile({ path: "builds/launch.moku.yaml" });

// Compile inline YAML (e.g. LLM output) — label in errors is "<inline>"
const inline = await app.buildfile.compile({ text: "version: 1\nname: demo\nitems: []\n", lang: "yaml" });

// Compile everything the configured default glob matches, in sorted order
const builds = await app.buildfile.loadGlob();

// Scaffold a new build file + its editor schema (what `moku new` does)
const text = app.buildfile.template({ name: "demo" });
const schema = app.buildfile.jsonSchema();

await app.stop();
```

Types are re-exported under the `Buildfile` namespace:

```ts
import type { Buildfile } from "@moku-labs/ai";

const item: Buildfile.BuildItem = { task: "voiceover", input: { text: "Hi", voice: "en-US-1" } };
const spec: Buildfile.BuildSpec = { version: 1, name: "demo", items: [item] };
```

## Integration

`buildfile` is a Wave-1 foundation plugin; three downstream plugins declare it in `depends` and
consume it via `ctx.require(buildfilePlugin)`:

- **runner** (`depends: [registryPlugin, buildfilePlugin]`) — every `run`, `resume`, `estimate`,
  and plan entry point calls `loadGlob(options.files)` to turn the file set into `CompiledBuild[]`
  before planning and dispatch. Provider fallback (`item.provider` → `defaults.provider` → first
  registered provider) and `input` validation happen there, at dispatch — never in `buildfile`.
- **compose** (`depends: [buildfilePlugin, promptGenPlugin]`) — embeds `jsonSchema()` in the LLM
  system prompt, round-trips every generated candidate through
  `compile({ text, lang: "yaml" })` (re-prompting on failure), derives the modeline's schema path
  from `template()`, and — for `--emit script` — emits a TS module targeting `defineBuild()`.
- **cli** — `moku new` writes `template({ name })` to disk and `jsonSchema()` to the schema path
  the template's modeline points at; `moku validate` is `loadGlob(pattern)` surfaced as a command,
  rejecting on the first invalid file (or an empty match) with the pinned two-line error.

Because `buildfile` never touches `registry`, all of the above validation paths work offline.
