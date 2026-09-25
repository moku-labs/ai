# video

> Owner of the "video" task contract and the typed one-off facade `app.video.*` — sync or async providers, one audited cast, zero state.

## Purpose

`video` is the task plugin for video clips in the `@moku-labs/ai` build system. It owns the
capability contract (`contract.ts`) that every video provider implements — `VideoRequest`,
`VideoResult`, `VideoJobPoll`, and `VideoHandler` — and exposes a small typed facade,
`app.video.*`, for one-off generation, cost estimation, and provider discovery.

Video providers run long jobs, so the contract has two forms. A handler has `estimate` plus
either `execute` (one call), or the async pair `submit` + `poll` (or both). The runner prefers
`submit`/`poll` and journals the job id, so an aborted run resumes by polling, never by
re-submitting. The facade `generate` prefers `execute`, and runs its own in-memory submit/poll
loop when the provider has no `execute`.

The registry transports handlers as `unknown`. `api.ts` performs the ONE audited cast for the
video task (spec/09 R9) behind the runtime guard `isVideoHandler`. A malformed registration fails
with the pinned error, never a crash. The plugin is stateless: no `state.ts`, no lifecycle, no
events.

## Configuration

Set under `pluginConfigs.video` in `createApp`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultProvider` | `string` | `"fal"` | Provider used by the facade when the caller names none. |
| `pollIntervalMs` | `number` | `5000` | Delay between polls in the facade's submit/poll loop, ms. |

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({
  pluginConfigs: { video: { defaultProvider: "fal", pollIntervalMs: 2000 } }
});
```

## The task contract (`contract.ts`)

Self-contained by design: this one file defines what a "video provider" is. Provider plugins
type-import it via `import type { VideoHandler } from "../video/contract"`. Consumers get the same
types as `Video.VideoHandler` etc.

### `VideoRequest`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | `string` | yes | Provider-scoped model id or alias, e.g. `"minimax-h3"`. Price and endpoint depend on it. |
| `prompt` | `string` | yes | Motion and scene prompt. |
| `negative` | `string` | no | Things to avoid. Ignored by models without a negative prompt. |
| `image` | `VideoFile` | no | First frame / keyframe. |
| `refs` | `VideoFile[]` | no | Extra references: images, audio or video files, told apart by MIME type. |
| `seconds` | `number` | no | Clip length in seconds. Default 5. |
| `aspect` | `string` | no | Aspect ratio. Default `"9:16"`. |
| `resolution` | `string` | no | Model-specific resolution, e.g. `"720p"`, `"768P"`. |
| `audio` | `boolean` | no | Generate native audio when the model can. Default false. |
| `params` | `Record<string, unknown>` | no | Pass-through provider params, merged last into the provider body. |

`VideoFile` is `{ path: string; mimeType: string; hash: string }`.

### `VideoResult`

| Field | Type | Description |
|-------|------|-------------|
| `video` | `Uint8Array` | The generated clip bytes. |
| `mimeType` | `string` | MIME type of `video`, e.g. `video/mp4`. |
| `costUsd` | `number` | Actual cost of this generation, in US dollars. |
| `meta` | `Record<string, unknown>?` | Metadata only, never a payload echo. |

### `VideoJobPoll`

```ts
type VideoJobPoll =
  | { state: "pending" }
  | ({ state: "done" } & VideoResult)
  | { state: "failed"; error: unknown };
```

### `VideoHandler`

```ts
export type VideoHandler = {
  estimate(request: VideoRequest): { usd: number };
  execute?(request: VideoRequest, opts: { signal?: AbortSignal }): Promise<VideoResult>;
  submit?(request: VideoRequest, opts: { signal?: AbortSignal }): Promise<{ jobId: string }>;
  poll?(jobId: string, request: VideoRequest, opts: { signal?: AbortSignal }): Promise<VideoJobPoll>;
};
```

A value is a valid handler when `estimate` is a function and either `execute` is a function or
both `submit` and `poll` are functions.

## API reference (`app.video.*`)

### `generate(request, opts?): Promise<VideoResult>`

One-off direct generation. **NOT journaled**: use `app.runner.run()` for resumability and a
durable cost ledger.

| Param | Type | Description |
|-------|------|-------------|
| `request` | `VideoRequest` | The video request. |
| `opts.provider` | `string?` | Provider override. Defaults to `config.defaultProvider`. |
| `opts.signal` | `AbortSignal?` | Cancels the provider call or the poll wait. |

- Provider has `execute`: calls it once and returns its result.
- Otherwise: calls `submit` once, then `poll` every `config.pollIntervalMs`.
  - `done`: returns the result without the `state` field.
  - `failed`: throws the poll's `error` as-is.
  - Abort during the wait: rejects at once with the signal's reason.

Unknown or malformed provider:

```
[ai] No video provider named "<name>" is registered.
  Available: <comma list or "none">.
```

```ts
const clip = await app.video.generate({ model: "minimax-h3", prompt: "slow push-in", image, seconds: 5 });
await Bun.write("clip.mp4", clip.video);
```

### `estimate(request, opts?): { usd: number }`

Cost estimate without executing. Delegates to the handler's own `estimate()`, the same one the
runner's budget gate uses. Throws the same pinned error for an unknown provider.

```ts
const { usd } = app.video.estimate({ model: "minimax-h3", prompt: "push-in", seconds: 5 });
```

### `providers(): string[]`

Registered video providers, in registration order. Delegates to `registry.providers("video")`.

```ts
app.video.providers(); // => ["fal"]
```

### Module-level export (not on `app.video`)

- `isVideoHandler(candidate)` — the runtime guard of the audited cast.

## Events

None.

## Integration

### registry (dependency)

`video` declares `depends: [registryPlugin]` and calls `resolve("video", provider)` and
`providers("video")`. `RegistryApi` is imported from `registry/index.ts` (declared once there) and
re-exported from `types.ts`.

### Provider plugins (fal)

Providers register a `VideoHandler` in their `onInit`. A Layer-3 custom provider works the same
way:

```ts
import { createPlugin, registryPlugin } from "@moku-labs/ai";
import type { Video } from "@moku-labs/ai";

const handler: Video.VideoHandler = {
  estimate: request => ({ usd: (request.seconds ?? 5) * 0.05 }),
  submit: async request => ({ jobId: await startJob(request) }),
  poll: async jobId => checkJob(jobId)
};

export const acmeVideoPlugin = createPlugin("acmeVideo", {
  depends: [registryPlugin],
  onInit: ctx => {
    ctx.require(registryPlugin).register("video", "acme", handler);
  }
});
```

### runner (durable path)

The runner dispatches to the same handlers. It prefers `submit`/`poll`, journals the job id, and
on resume polls the live job instead of submitting again.
