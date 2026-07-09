# buildfile

> Standard plugin — YAML + `defineBuild()` → one zod-validated `BuildSpec` IR; JSON Schema + `moku new` templates from the same source.

The build-file front-end. `*.moku.yaml` (canonical, YAML) and `defineBuild()` (TypeScript) both
compile through the same zod schema (`schema.ts`), so the runtime validator, the generated JSON
Schema, and the `moku new` template can never drift. Consumed by `runner` (run/estimate), `cli`
(new/validate), and `compose` (typed generation target for `--emit`).

## Config

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `defaultGlob` | `string` | `"**/*.moku.yaml"` | Glob used when a run/validate is invoked without an explicit pattern. |
| `schemaPath` | `string` | `".moku/build.schema.json"` | Where `moku new` writes the generated JSON Schema for the modeline to point at. |

## The IR

```ts
type BuildItem = {
  task: string; // "voiceover" | "translate" | "prompt-gen" | open set
  id?: string;
  provider?: string;
  input: Record<string, unknown>;
  params?: Record<string, unknown>;
  pack?: { name: string; version: string };
};
type BuildSpec = {
  version: 1;
  name: string;
  defaults?: { provider?: string; maxAttempts?: number };
  items: BuildItem[];
  itemsFrom?: string; // optional NDJSON file merged into items at compile time
};
```

`BuildSpec`/`BuildItem` are `z.infer` of `buildSpecSchema`/`buildItemSchema` (`schema.ts`) — the
single source of truth. The generated JSON Schema can never drift from the runtime validator
because both come from the same zod object.

## API

### `compile(source): Promise<CompiledBuild>`
Parses and validates one source (`{ path }` — YAML or TS, dispatched by extension — or
`{ text, lang: "yaml" }`) into `{ file, spec }`. TS build files are dynamically imported and must
default-export a `defineBuild()` result. Expands `itemsFrom` NDJSON (one `BuildItem` per line,
resolved relative to the source's directory) into `spec.items`.

Validation failure throws:
```
[ai] Build file "<path>" is invalid.
  <first zod issue path>: <message>.
```

### `loadGlob(pattern?): Promise<CompiledBuild[]>`
Expands a glob (or `config.defaultGlob`) and compiles every match, in deterministic (sorted) path
order. An empty match set throws a two-line error suggesting `moku new`.

### `jsonSchema(): Record<string, unknown>`
The JSON Schema generated from `buildSpecSchema` via `z.toJSONSchema` — used by `moku new` to
populate `config.schemaPath`.

### `template(opts: { name: string }): string`
Starter build-file text for `moku new`. Emits BOTH the yaml-language-server modeline
(`# yaml-language-server: $schema=<path>`) and the `$schema:` key — the literal `$schema:` key
alone does NOT activate editor autocomplete; the modeline comment is required. Includes a
commented example item per M0 task (voiceover, translate, prompt-gen). The rendered text is
itself a valid, compilable build file.

## Standalone helper

```ts
export function defineBuild(spec: BuildSpec): BuildSpec;
```
Pure factory — no ctx, no lifecycle, no side effects. Identity function that validates through the
same zod schema `compile()` uses; the typed generation target for `compose --emit script`.

```ts
import { defineBuild } from "@moku-labs/ai";

export default defineBuild({
  version: 1,
  name: "demo",
  items: [{ task: "voiceover", input: { text: "Hello, world!", voice: "en-US-1" } }]
});
```

## Events

None.

## Dependencies

None. `registry` is deliberately NOT consulted at compile time — provider existence is checked at
dispatch by the runner, so `moku validate` works offline without providers configured.

## Usage

```typescript
const app = createApp({
  pluginConfigs: { buildfile: { defaultGlob: "builds/**/*.moku.yaml" } }
});

// Compile one file
const { spec } = await app.buildfile.compile({ path: "build.moku.yaml" });

// Compile every match of a glob
const builds = await app.buildfile.loadGlob();

// Scaffold a new build file
const text = app.buildfile.template({ name: "demo" });

// JSON Schema for editor tooling / `moku new`
const schema = app.buildfile.jsonSchema();
```
