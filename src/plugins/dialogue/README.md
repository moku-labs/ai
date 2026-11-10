# dialogue

> Owner of the "dialogue" task contract and the typed one-off facade `app.dialogue.*` — a multi-speaker scene generated in one provider request, returned as the whole mix plus one audio file per line. One runtime guard, zero state.

## Purpose

`dialogue` is the task plugin for spoken scenes in the `@moku-labs/ai` build system. It owns the
capability contract (`contract.ts`) that every dialogue provider implements — `DialogueRequest`,
`DialogueResult`, and `DialogueHandler` — and exposes a small typed facade, `app.dialogue.*`, for
one-off generation, cost estimation, and provider discovery.

A scene is several lines by several voices, generated in a single request so the delivery flows
from one line into the next. The result carries the whole scene and one file per line, so a game
can play a line on its own. Use `voiceover` for one voice and one line at a time.

A handler has `estimate` and `execute`. There is no async `submit`/`poll` form: a scene is
returned in one call.

`DialogueResult` is structurally a runner `HandlerResult` (`audio` + `mimeType` + `outputs`), so
the runner stores and exports every output with no dialogue-specific code.

The registry transports handlers as `unknown`. `api.ts` narrows them for the dialogue task
(spec/09 R9) with the runtime guard `isDialogueHandler`, with no cast. A malformed registration
fails with the pinned error, never a crash. The plugin is stateless: no `state.ts`, no lifecycle,
no events.

## Configuration

Set under `pluginConfigs.dialogue` in `createApp`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultProvider` | `string` | `"elevenlabs"` | Provider used by the facade when the caller names none. |

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({
  pluginConfigs: { dialogue: { defaultProvider: "acme" } }
});
```

## The task contract (`contract.ts`)

Self-contained by design: this one file defines what a "dialogue provider" is, and it imports no
plugin module. Provider plugins type-import it via
`import type { DialogueHandler } from "../dialogue/contract"` with no `depends` edge. Consumers
get the same types as `Dialogue.DialogueHandler` etc.

### `DialogueRequest`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `lines` | `DialogueLine[]` | yes | The lines in speaking order. |
| `model` | `string` | yes | Provider-scoped model alias (elevenlabs: `eleven_v4`, recommended). Required, like `sfx`: the runner hashes the input as written, so a model defaulted inside the provider would not be part of the artifact key and a changed default would reuse another model's scene. A provider refuses a request without it. |
| `language` | `string` | no | BCP-47 / ISO 639-1 language hint. |
| `settings` | `DialogueSettings` | no | Scene-wide `stability` and `similarity`. |
| `seed` | `number` | no | Seed for repeatable takes. |
| `outputFormat` | `string` | no | Provider-scoped format code, e.g. `"mp3_44100_192"` or `"wav_44100"`. |
| `params` | `Record<string, unknown>` | no | Raw provider fields, spread last. |

### `DialogueLine`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | no | File name of this line's cut (no extension, no slash), e.g. `"ep02-signAlice-ru"`. |
| `text` | `string` | yes | Text to speak; audio tags are allowed for models that take them (`"[tense] ..."`). |
| `voice` | `string` | yes | Provider-scoped voice id. |

### `DialogueResult`

| Field | Type | Description |
|-------|------|-------------|
| `audio` | `Uint8Array` | The whole scene. |
| `mimeType` | `string` | MIME type of `audio`. |
| `costUsd` | `number` | Actual cost of this generation, in US dollars. |
| `outputs` | `{ bytes, mimeType, name? }[]` | `outputs[0]` is the whole scene; then one entry per line that has speech, in line order. |
| `lines` | `DialogueLineTiming[]` | The cut window (`startMs`, `endMs`) of each line that has a file. |
| `meta` | `Record<string, unknown>?` | Metadata only, never a payload echo. |

### `DialogueHandler`

```ts
export type DialogueHandler = {
  estimate(request: DialogueRequest): { usd: number };
  execute(request: DialogueRequest, opts: { signal?: AbortSignal }): Promise<DialogueResult>;
};
```

A value is a valid handler when both `estimate` and `execute` are functions.

## API reference (`app.dialogue.*`)

### `generate(request, opts?): Promise<DialogueResult>`

One-off direct generation. Resolves the provider's handler and calls `execute` once. **NOT
journaled**: use `app.runner.run()` for resumability and a durable cost ledger.

| Param | Type | Description |
|-------|------|-------------|
| `request` | `DialogueRequest` | The dialogue request. |
| `opts.provider` | `string?` | Provider override. Defaults to `config.defaultProvider`. |
| `opts.signal` | `AbortSignal?` | Passed to the provider's `execute`. |

A handler error is thrown as-is. Unknown or malformed provider:

```
[ai] No dialogue provider named "<name>" is registered.
  Available: <comma list or "none">.
```

```ts
const scene = await app.dialogue.generate({
  model: "eleven_v4",
  language: "ru",
  seed: 7,
  settings: { stability: 0.5, similarity: 0.75 },
  lines: [
    { id: "signAlice", text: "[tense] Я ничего не подписывала!", voice: "TPIitICAZ8CqlGZ81AKm" },
    { id: "signDaniel", text: "[bitterly] Ты давно здесь не живёшь, Элис.", voice: "6A9D8WSMm4rFsg2DWFeE" }
  ]
});
await writeFile("scene.mp3", scene.audio); // writeFile from "node:fs/promises"
for (const out of scene.outputs.slice(1)) await writeFile(`${out.name}.mp3`, out.bytes);
```

### `estimate(request, opts?): { usd: number }`

Cost estimate without executing. Delegates to the handler's own `estimate()`, the same one the
runner's budget gate uses. Throws the same pinned error for an unknown provider.

```ts
const { usd } = app.dialogue.estimate({ model: "eleven_v4", lines: [{ text: "Hi", voice: "v1" }] });
```

### `providers(): string[]`

Registered dialogue providers, in registration order. Delegates to `registry.providers("dialogue")`.

```ts
const names: string[] = app.dialogue.providers(); // ["elevenlabs"]
```

### Module-level export (not on `app.dialogue`)

- `isDialogueHandler(candidate)` — the runtime guard that narrows registry values.

## Events

None.

## Integration

### registry (dependency)

`dialogue` declares `depends: [registryPlugin]` and calls `resolve("dialogue", provider)` and
`providers("dialogue")`. `RegistryApi` is imported from `registry/index.ts` (declared once there)
and re-exported from `types.ts`.

### Providers

| Provider | Registered by | Notes |
|----------|---------------|-------|
| `elevenlabs` | the `elevenlabs` plugin, in its `onInit` | Model `eleven_v4` (recommended; the request names it), scene cut into one mp3 per line. Limits, cut padding and tier notes: see the [elevenlabs README](../elevenlabs/README.md). |

A Layer-3 custom provider works the same way:

```ts
import { createPlugin, registryPlugin } from "@moku-labs/ai";
import type { Dialogue } from "@moku-labs/ai";

const handler: Dialogue.DialogueHandler = {
  estimate: request => ({ usd: request.lines.length * 0.1 }),
  execute: async (request, { signal }) => callAcme(request, signal)
};

export const acmeDialoguePlugin = createPlugin("acmeDialogue", {
  depends: [registryPlugin],
  onInit: ctx => {
    ctx.require(registryPlugin).register("dialogue", "acme", handler);
  }
});
```

### runner (durable path)

The runner accepts `task: dialogue` build items with no change. It dispatches to the same
handlers, stores every output and exports the mix as `<label>.<ext>` plus one file per named line
beside it.

```yaml
- id: voices/ep02-quarrel
  task: dialogue
  provider: elevenlabs
  input:
    model: eleven_v4
    language: ru
    seed: 7
    settings: { stability: 0.5, similarity: 0.75 }
    lines:
      - { id: ep02-signAlice-ru, text: "[tense] Я ничего не подписывала!", voice: TPIitICAZ8CqlGZ81AKm }
      - { id: ep02-signDaniel-ru, text: "[bitterly] Ты давно здесь не живёшь, Элис.", voice: 6A9D8WSMm4rFsg2DWFeE }
```

Export: `out/<build>/voices/ep02-quarrel.mp3`, `out/<build>/voices/ep02-signAlice-ru.mp3`,
`out/<build>/voices/ep02-signDaniel-ru.mp3`.
