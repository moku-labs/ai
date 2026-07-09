# compose

> Standard plugin — prompt → validated build file (YAML or `defineBuild()` script) via the promptGen facade + buildfile IR

Turns a natural-language description into a build file. Generation goes through `promptGen`'s
facade (not `registry` directly — the audited task cast belongs to the owning task plugin, a
ratified decision) and every candidate is validated through `buildfile`'s zod IR before it is ever
returned: **compose can never hand back an invalid build file.** When the model's output fails
validation, compose re-prompts with the validation issue, bounded by `config.maxRepairAttempts`
additional attempts, before giving up.

## Config

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `provider` | `string` | `"openai"` | Provider passed to `promptGen.generate`. |
| `maxRepairAttempts` | `number` | `2` | Additional regeneration attempts when output fails IR validation (total attempts = 1 + this). |

## API

### `compose(opts): Promise<{ spec, text, costUsd }>`

```ts
compose(opts: {
  prompt: string;
  emit: "build" | "script";
  name?: string;
  signal?: AbortSignal;
}): Promise<{ spec: BuildSpec; text: string; costUsd: number }>;
```

Pipeline:

1. Build a system prompt embedding `buildfile.jsonSchema()` plus per-task input documentation.
2. Call `promptGen.generate({ prompt, system }, { provider, signal })`.
3. Strip a defensive markdown fence (` ```yaml ... ``` `) from the model output, if present.
4. Validate through `buildfile.compile({ text, lang: "yaml" })` (the zod IR).
5. On failure, re-prompt with the validation issue and retry, up to `config.maxRepairAttempts`
   additional times.
6. On success, apply `opts.name`'s override (if given) and emit:
   - `"build"` → YAML text with the yaml-language-server modeline and `$schema:` key (same
     conventions `buildfile.template()` uses for `moku new`).
   - `"script"` → a `defineBuild()` TypeScript module (`import { defineBuild } from "@moku-labs/ai"`).

`costUsd` is the sum of every `promptGen.generate` call's cost across the whole repair loop.
`compose()` never writes files — the `cli` command is responsible for persisting the returned text.

Exhausting every attempt throws:
```
[ai] Compose could not produce a valid build file after <n> attempts.
  Refine the prompt or write the build file manually with "moku new".
```

## Events

None.

## Dependencies

- `buildfilePlugin` — `jsonSchema()` for the system prompt, `compile()` for validation, and
  `template()` to derive the YAML modeline's schema path.
- `promptGenPlugin` — `generate()` for LLM output. compose does **not** depend on `registry`
  directly; it reaches prompt generation exclusively through the `promptGen` facade.

## Usage

```typescript
const app = createApp({
  pluginConfigs: { compose: { provider: "openai", maxRepairAttempts: 2 } }
});

const { spec, text, costUsd } = await app.compose.compose({
  prompt: "Narrate a two-line intro in English, then translate it to Spanish.",
  emit: "build"
});

// Or generate a typed defineBuild() script instead:
const script = await app.compose.compose({ prompt: "...", emit: "script", name: "intro" });
```
