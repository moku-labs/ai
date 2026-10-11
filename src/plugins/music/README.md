# music

> Owner of the "music" task contract and the typed one-off facade `app.music.*` — sync or async providers, one runtime guard, zero state.

## Purpose

`music` is the task plugin for music tracks in the `@moku-labs/ai` build system. It owns the
capability contract (`contract.ts`) that every music provider implements — `MusicChunk`,
`MusicRequest`, `MusicResult`, `MusicJobPoll`, and `MusicHandler` — and exposes a small typed
facade, `app.music.*`, for one-off generation, cost estimation, and provider discovery.

A handler has `estimate` plus either `execute` (one call), or the async pair `submit` + `poll` (or
both). The runner prefers `submit`/`poll` and journals the job id, so an aborted run resumes by
polling, never by re-submitting. The facade `generate` prefers `execute`, and runs its own
in-memory submit/poll loop when the provider has no `execute`.

The registry transports handlers as `unknown`. `api.ts` narrows them for the music task
(spec/09 R9) with the runtime guard `isMusicHandler`, with no cast. A malformed registration fails
with the pinned error, never a crash. The plugin is stateless: no `state.ts`, no lifecycle, no
events.

`MusicRequest.model` is required. The runner hashes the build item's input as written, so a model
defaulted inside a provider would not be part of the artifact key: a changed default would reuse
another model's audio. There is no automatic fallback to a second model.

## Configuration

Set under `pluginConfigs.music` in `createApp`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultProvider` | `string` | `"fal"` | Provider used by the facade when the caller names none. |
| `pollIntervalMs` | `number` | `5000` | Delay between polls in the facade's submit/poll loop, ms. |

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({
  pluginConfigs: { music: { defaultProvider: "fal", pollIntervalMs: 2000 } }
});
```

## The task contract (`contract.ts`)

Self-contained by design: this one file defines what a "music provider" is, and it imports no
plugin module. Provider plugins type-import it via
`import type { MusicHandler } from "../music/contract"` with no `depends` edge. Consumers get the
same types as `Music.MusicHandler` etc.

### `MusicRequest`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | `string` | yes | Overall music prompt. |
| `model` | `string` | yes | Provider-scoped model alias, e.g. `"elevenlabs-music-v2.5"`. Price, endpoint and output depend on it. |
| `lengthMs` | `number` | yes | Track length, ms. |
| `chunks` | `MusicChunk[]` | no | Composition plan. A model without plans rejects it, never drops it silently. |
| `seed` | `number` | no | Seed, when the model takes one. |
| `params` | `Record<string, unknown>` | no | Provider params; each provider documents which keys it reads (fal reads none; elevenlabs reads `output_format` and `force_instrumental`). |

### `MusicChunk`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | `string` | yes | Lyrics or section description. |
| `durationMs` | `number` | yes | Section length, ms. |
| `styles` | `string[]` | yes | Positive style tags. |
| `avoid` | `string[]` | no | Negative style tags. |

### `MusicResult`

| Field | Type | Description |
|-------|------|-------------|
| `audio` | `Uint8Array` | The generated audio bytes. |
| `mimeType` | `string` | MIME type of `audio`, e.g. `audio/mpeg`. |
| `costUsd` | `number` | Actual cost of this generation, in US dollars. |
| `meta` | `Record<string, unknown>?` | Metadata only, never a payload echo. |

The shape matches `VoiceoverResult`: the runner stores `audio` results and maps `audio/mpeg` to
`.mp3`.

### `MusicJobPoll`

```ts
type MusicJobPoll =
  | { state: "pending" }
  | ({ state: "done" } & MusicResult)
  | { state: "failed"; error: unknown };
```

### `MusicHandler`

```ts
export type MusicHandler = {
  estimate(request: MusicRequest): { usd: number };
  execute?(request: MusicRequest, opts: { signal?: AbortSignal }): Promise<MusicResult>;
  submit?(request: MusicRequest, opts: { signal?: AbortSignal }): Promise<{ jobId: string }>;
  poll?(jobId: string, request: MusicRequest, opts: { signal?: AbortSignal }): Promise<MusicJobPoll>;
};
```

A value is a valid handler when `estimate` is a function and either `execute` is a function or
both `submit` and `poll` are functions.

## API reference (`app.music.*`)

### `generate(request, opts?): Promise<MusicResult>`

One-off direct generation. **NOT journaled**: use `app.runner.run()` for resumability and a
durable cost ledger.

| Param | Type | Description |
|-------|------|-------------|
| `request` | `MusicRequest` | The music request. |
| `opts.provider` | `string?` | Provider override. Defaults to `config.defaultProvider`. |
| `opts.signal` | `AbortSignal?` | Cancels the provider call or the poll wait. |

- Provider has `execute`: calls it once and returns its result.
- Otherwise: calls `submit` once, then `poll` every `config.pollIntervalMs`.
  - `done`: returns the result without the `state` field.
  - `failed`: throws the poll's `error` as-is.
  - Abort during the wait: rejects at once with the signal's reason.

Unknown or malformed provider:

```
[ai] No music provider named "<name>" is registered.
  Available: <comma list or "none">.
```

```ts
const track = await app.music.generate({
  prompt: "tense synth",
  model: "elevenlabs-music-v2.5",
  lengthMs: 60_000,
  chunks: [
    { text: "intro", durationMs: 20_000, styles: ["ambient"] },
    { text: "build", durationMs: 40_000, styles: ["synthwave", "driving"], avoid: ["vocals"] }
  ]
});
await Bun.write("teaser.mp3", track.audio);
```

### `estimate(request, opts?): { usd: number }`

Cost estimate without executing. Delegates to the handler's own `estimate()`, the same one the
runner's budget gate uses. Throws the same pinned error for an unknown provider.

```ts
const { usd } = app.music.estimate({ prompt: "x", model: "stable-audio-2.5", lengthMs: 30_000 });
```

### `providers(): string[]`

Registered music providers, in registration order. Delegates to `registry.providers("music")`.

```ts
app.music.providers(); // => ["elevenlabs", "fal"]
```

### Module-level export (not on `app.music`)

- `isMusicHandler(candidate)` — the runtime guard that narrows registry values.

## Events

None.

## Integration

### registry (dependency)

`music` declares `depends: [registryPlugin]` and calls `resolve("music", provider)` and
`providers("music")`. `RegistryApi` is imported from `registry/index.ts` (declared once there) and
re-exported from `types.ts`.

### Provider plugins (fal)

Providers register a `MusicHandler` in their `onInit`; `("music", "elevenlabs")` and `("music", "fal")` ship in the package; the default stays `fal` through `defaultProvider`. A Layer-3
custom provider works the same way:

```ts
import { createPlugin, registryPlugin } from "@moku-labs/ai";
import type { Music } from "@moku-labs/ai";

const handler: Music.MusicHandler = {
  estimate: request => ({ usd: Math.ceil(request.lengthMs / 60_000) * 0.8 }),
  submit: async request => ({ jobId: await startJob(request) }),
  poll: async jobId => checkJob(jobId)
};

export const acmeMusicPlugin = createPlugin("acmeMusic", {
  depends: [registryPlugin],
  onInit: ctx => {
    ctx.require(registryPlugin).register("music", "acme", handler);
  }
});
```

### runner (durable path)

The runner accepts `task: music` build items with no change. It dispatches to the same handlers,
prefers `submit`/`poll`, journals the job id, and on resume polls the live job instead of
submitting again.

```yaml
- task: music
  id: teaser-score
  input:
    model: "elevenlabs-music-v2.5"
    prompt: "Tense synth pulse, rising."
    lengthMs: 30000
```
