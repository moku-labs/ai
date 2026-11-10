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
  task (`voiceover`, `translate`, `prompt-gen`, `image`, `video`, `music`, `sfx`, an
  `image` → `sprite` pair with a `{nine=l,t,r,b}` id hint, and a `dialogue` scene). The rendered text is itself a valid,
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
| `locales` | `string[]` | no | The build's locale set (see "Locales and cast"). |
| `cast` | `Record<string, CastEntry>` | no | Named characters with per-locale overrides (see "Locales and cast"). |

### `BuildItem` (one task invocation)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `task` | `string` | yes | Task name — `"voiceover"`, `"translate"`, `"prompt-gen"`, or any registered task (open set; existence is checked by the runner, not here). |
| `id` | `string` | no | Human label (export file name) and `$ref` target. Unique within a build file. Not identity. Braces are allowed only as one trailing label hint (see below). |
| `provider` | `string` | no | Provider override; the runner falls back to `defaults.provider`, else the task's first registered provider. |
| `input` | `Record<string, unknown>` | yes | Task-specific request payload, handed to the provider flat (`{ ...input, params }`). May hold `$ref` / `$file` values. A `params` key inside `input` is refused. Put params next to input. |
| `params` | `Record<string, unknown>` | no | Output-relevant parameters — part of the runner's planning key. Goes next to `input`, never inside it. |
| `locales` | `true \| string[]` | no | Expand this item into one item per locale (see "Locales and cast"). |

`compile()` refuses `input.params`. The runner would drop it silently. The error reads
`items.0.input.params: params go next to input, not inside it; move input.params to params.`
| `pack` | `{ name: string; version: string }` | no | Asset-pack association. |

### References: `$ref` and `$file`

Any value inside `input` (nested objects and arrays included) may be a reference:

| Value | Means |
|---|---|
| `{ $ref: "<item id>" }` | The artifact of another item in the same build file. It runs first. |
| `{ $file: "<path>" }` | A local file, relative to the build file (absolute allowed). Its content hash is part of the item's keys. |

`compile()` rejects a duplicate `id`, a `$ref` to an unknown id, a `$ref` cycle, and a
reference value that is not a non-empty string, with the usual two-line error, for example
`items.1.input: unknown $ref "s01.key"`. A missing `$file` is reported by the runner when it plans.

```yaml
items:
  - id: s01.key
    task: image
    input: { prompt: "patisserie at night", refs: [{ $file: refs/akari.png }] }
  - id: s01.clip
    task: video
    input: { model: minimax-h3, prompt: "slow push-in", image: { $ref: s01.key } }
```

### Label hints

An item `id` may end with one nine-slice hint: `<label>{nine=l,t,r,b}`.
The four values are whole-pixel insets: left, top, right, bottom.
The hint stays in the exported file name, for example `button{nine=12,12,12,12}.png`.
The game engine reads it there.

Any other use of `{` or `}` in an `id` is refused: a malformed hint, a non-integer inset,
a brace in the middle, or an unknown key. The error reads
`items.1.id: only a trailing {nine=l,t,r,b} hint with whole-pixel insets is allowed.`
An `id` without braces is unchanged.

A sprite takes two items. An `image` item makes the raw picture. A `sprite` item takes it by
`$ref` and cuts it, so re-cutting never regenerates the image.

```yaml
items:
  - id: btn-raw
    task: image
    input: { prompt: "wooden game UI button, flat colour background", aspect: "1:1" }
  - id: "button{nine=12,12,12,12}"
    task: sprite
    input: { source: { $ref: btn-raw }, size: { width: 128, height: 64 }, padding: 2 }
```

### Locales and cast

One scene definition can build one item per language, each with its own voices. Two top-level fields
and one item field do it; a build file that uses none of them compiles exactly as before.

| Field | Where | Type | Meaning |
|---|---|---|---|
| `locales` | top level | `string[]` (non-empty, unique, codes like `ru`, `en`, `pt-BR`) | The build's locale set. |
| `cast` | top level | `Record<string, CastEntry>` | Named characters: base fields (`voice`, `settings`, `model`, ...) plus per-locale overrides under `locales`. |
| `locales` | item | `true \| string[]` | Expand this item per locale. `true` means the top-level list; a list must be a subset of it. |

```yaml
locales: [ru, en]
cast:
  alice:
    voice: TPIitICAZ8CqlGZ81AKm              # the ru voice
    locales:
      en: { voice: <english voice id> }
  mira:
    voice: EDpEYNf6XIeKYRzYcx4I
    settings: { stability: 0.5 }
    locales:
      en: { voice: <english voice id>, settings: { stability: 0.6 } }
items:
  - id: voices/ep02-quarrel-${locale}
    task: dialogue
    locales: true
    input:
      model: eleven_v4
      language: ${locale}
      lines:
        - { id: "ep02-signAlice-${locale}", $cast: alice,
            text: { ru: "Я ничего не подписывала!", en: "I never signed anything!" } }
  - id: voices/promo-line3
    task: voiceover
    locales: true
    input:
      $cast: mira
      language: ${locale}
      text: { ru: "Новый пациент.", en: "A new patient." }
```

This compiles to `voices/ep02-quarrel-ru`, `voices/ep02-quarrel-en`, `voices/promo-line3-ru` and
`voices/promo-line3-en`. Each is an ordinary item with its own planning key and cache entry, so
changing one cast voice re-runs exactly the items that use it. Expansion is deterministic and runs
in `compile()` after `itemsFrom` and before the `$ref` check; `defineBuild()` only validates.

Rules, for an item that expands (the **locale** is the one being built):

- **Ids.** The item needs an `id`. `${locale}` in it is replaced; an id without it gets `-<locale>`
  appended (`man-door` becomes `man-door-ru`), in front of a trailing `{nine=...}` hint
  (`button{nine=1,2,3,4}` becomes `button-ru{nine=1,2,3,4}`).
- **Localized values.** In `input` and `params`, an object whose keys are all locale codes (the
  top-level list plus the item's own) is replaced by its entry for the locale. A missing entry is an
  error naming the path: `items.0.input.lines.2.text: no "en" value`. An object like
  `{ width: 128, height: 64 }` is left alone.
- **`${locale}`** in any string of `input` and `params` (including inside `$ref` and `$file`) is
  replaced by the locale code.
- **`$cast: <name>`** in an object merges the cast member's base fields with its override for the
  locale; the object's own keys win. An unknown name is an error:
  `items.0.input.lines.0.$cast: no cast member "bob"`.
- **Ids inside `input`.** Every string at a key named `id` anywhere in `input` (a dialogue line id, for
  example) must contain `${locale}` or be a localized value, since every locale would otherwise export
  to the same file. Otherwise: `items.0.input.lines.0.id: an id inside a localized item needs ${locale}`.

An item without `locales` is not expanded: `$cast` resolves with the base fields only, and
`${locale}` and localized values stay as written. The item-level `locales` key is removed from the
compiled items; `cast` and the top-level `locales` stay on the spec for tooling.

Errors use the usual two-line format, for example `items.1.locales: true needs a top-level locales
list` or `items.0.locales: "fr" is not in the top-level locales list`.

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
