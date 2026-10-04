# sfx

> Owner of the "sfx" task contract and the typed one-off facade `app.sfx.*` — short sound effects from a text prompt, always mp3, one runtime guard, zero state.

## Purpose

`sfx` is the task plugin for game sound effects in the `@moku-labs/ai` build system. It owns the
capability contract (`contract.ts`) that every sfx provider implements — `SfxRequest`,
`SfxResult`, and `SfxHandler` — and exposes a small typed facade, `app.sfx.*`, for one-off
generation, cost estimation, and provider discovery.

A handler has `estimate` and `execute`. There is no async `submit`/`poll` form: a sound effect is
a few seconds of audio and every provider returns it in one call.

The output is always mp3 (`audio/mpeg`). The game engine accepts mp3 only, so a handler never
returns another format and there is no transcoder. The runner maps `audio/mpeg` to `.mp3` on
export.

The registry transports handlers as `unknown`. `api.ts` narrows them for the sfx task
(spec/09 R9) with the runtime guard `isSfxHandler`, with no cast. A malformed registration fails
with the pinned error, never a crash. The plugin is stateless: no `state.ts`, no lifecycle, no
events.

`SfxRequest.model` is required. The runner hashes the build item's input as written, so a model
defaulted inside a provider would not be part of the artifact key: a changed default would reuse
another model's audio.

## Configuration

Set under `pluginConfigs.sfx` in `createApp`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultProvider` | `string` | `"elevenlabs"` | Provider used by the facade when the caller names none. |

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({
  pluginConfigs: { sfx: { defaultProvider: "fal" } }
});
```

## The task contract (`contract.ts`)

Self-contained by design: this one file defines what an "sfx provider" is, and it imports no
plugin module. Provider plugins type-import it via
`import type { SfxHandler } from "../sfx/contract"` with no `depends` edge. Consumers get the
same types as `Sfx.SfxHandler` etc.

### `SfxRequest`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | `string` | yes | What the sound is, e.g. `"coin pickup, bright 8-bit chime"`. |
| `model` | `string` | yes | Provider-scoped model alias, e.g. `"eleven_text_to_sound_v2"`. Part of the artifact key. |
| `durationMs` | `number` | no | Length in ms. Omitted means the provider picks the length. Providers check their own range. |
| `promptInfluence` | `number` | no | 0..1, how literally the prompt is followed. |
| `loop` | `boolean` | no | Ask for a seamless loop, when the model supports it. |
| `params` | `Record<string, unknown>` | no | Provider params; each provider documents the keys it reads. |

### `SfxResult`

| Field | Type | Description |
|-------|------|-------------|
| `audio` | `Uint8Array` | The generated mp3 bytes. |
| `mimeType` | `"audio/mpeg"` | Always mp3. |
| `costUsd` | `number` | Actual cost of this generation, in US dollars. |
| `meta` | `Record<string, unknown>?` | Metadata only (model, endpoint, requestId, durationMs), never a payload echo. |

### `SfxHandler`

```ts
export type SfxHandler = {
  estimate(request: SfxRequest): { usd: number };
  execute(request: SfxRequest, opts: { signal?: AbortSignal }): Promise<SfxResult>;
};
```

A value is a valid handler when both `estimate` and `execute` are functions.

## API reference (`app.sfx.*`)

### `generate(request, opts?): Promise<SfxResult>`

One-off direct generation. Resolves the provider's handler and calls `execute` once. **NOT
journaled**: use `app.runner.run()` for resumability and a durable cost ledger.

| Param | Type | Description |
|-------|------|-------------|
| `request` | `SfxRequest` | The sfx request. |
| `opts.provider` | `string?` | Provider override. Defaults to `config.defaultProvider`. |
| `opts.signal` | `AbortSignal?` | Passed to the provider's `execute`. |

A handler error is thrown as-is. Unknown or malformed provider:

```
[ai] No sfx provider named "<name>" is registered.
  Available: <comma list or "none">.
```

```ts
const hit = await app.sfx.generate({
  prompt: "sword hit, metallic",
  model: "eleven_text_to_sound_v2",
  durationMs: 800
});
await Bun.write("sword-hit.mp3", hit.audio);
```

### `estimate(request, opts?): { usd: number }`

Cost estimate without executing. Delegates to the handler's own `estimate()`, the same one the
runner's budget gate uses. Throws the same pinned error for an unknown provider.

```ts
const { usd } = app.sfx.estimate(
  { prompt: "coin pickup", model: "elevenlabs-sfx-v2", durationMs: 2000 },
  { provider: "fal" }
);
```

### `providers(): string[]`

Registered sfx providers, in registration order. Delegates to `registry.providers("sfx")`.

```ts
app.sfx.providers(); // => ["elevenlabs", "fal"]
```

### Module-level export (not on `app.sfx`)

- `isSfxHandler(candidate)` — the runtime guard that narrows registry values.

## Events

None.

## Integration

### registry (dependency)

`sfx` declares `depends: [registryPlugin]` and calls `resolve("sfx", provider)` and
`providers("sfx")`. `RegistryApi` is imported from `registry/index.ts` (declared once there) and
re-exported from `types.ts`.

### Provider plugins (elevenlabs, fal)

Providers register an `SfxHandler` in their `onInit`. elevenlabs is registered before fal, so it is
the default. "Fallback" means picking the second provider with `provider: fal`: the runner has no
automatic failover. A Layer-3 custom provider works the same way:

```ts
import { createPlugin, registryPlugin } from "@moku-labs/ai";
import type { Sfx } from "@moku-labs/ai";

const handler: Sfx.SfxHandler = {
  estimate: request => ({ usd: Math.ceil((request.durationMs ?? 1000) / 1000) * 0.12 }),
  execute: async (request, { signal }) => callAcme(request, signal)
};

export const acmeSfxPlugin = createPlugin("acmeSfx", {
  depends: [registryPlugin],
  onInit: ctx => {
    ctx.require(registryPlugin).register("sfx", "acme", handler);
  }
});
```

### runner (durable path)

The runner accepts `task: sfx` build items with no change. It dispatches to the same handlers and
exports each result as `<label>.mp3`.

```yaml
- task: sfx
  id: coin-pickup
  input: { prompt: "coin pickup, bright chime", model: eleven_text_to_sound_v2, durationMs: 600 }
- task: sfx
  id: coin-pickup-alt
  provider: fal
  input: { prompt: "coin pickup, bright chime", model: elevenlabs-sfx-v2, durationMs: 600 }
```
