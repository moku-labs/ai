# upscale

> Owner of the "upscale" task contract and the typed one-off facade `app.upscale.*`: one video in, the same video upscaled out. Sync or async providers, one runtime guard, zero state.

## Purpose

`upscale` is the task plugin for video upscaling in the `@moku-labs/ai` build system. It owns the
capability contract (`contract.ts`) that every upscale provider implements: `UpscaleFile`,
`UpscaleRequest`, `UpscaleEstimateRequest`, `UpscaleResult`, `UpscaleJobPoll` and `UpscaleHandler`.
It exposes a small typed facade, `app.upscale.*`, for one-off upscaling, cost estimation and
provider discovery.

A handler has `estimate` plus either `execute` (one call), or the async pair `submit` + `poll` (or
both). The runner prefers `submit`/`poll` and journals the job id, so an aborted run resumes by
polling, never by re-submitting. The facade `generate` prefers `execute`, and runs its own
in-memory submit/poll loop when the provider has no `execute`.

The registry transports handlers as `unknown`. `api.ts` narrows them for the upscale task
(spec/09 R9) with the runtime guard `isUpscaleHandler`, with no cast. A malformed registration fails
with the pinned error, never a crash. The plugin is stateless: no `state.ts`, no lifecycle, no
events.

`UpscaleRequest.model` is required. The runner hashes the build item's input as written, so a model
defaulted inside a provider would not be part of the artifact key: a changed default would reuse
another model's video. There is no automatic fallback to a second model.

At plan time the runner estimates before references resolve, so `UpscaleEstimateRequest.video` may
still be `{ $ref }` or `{ $file }`. `generate` and `execute`/`submit` always get a resolved
`UpscaleFile`.

## Configuration

Set under `pluginConfigs.upscale` in `createApp`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultProvider` | `string` | `"fal"` | Provider used by the facade when the caller names none. |
| `pollIntervalMs` | `number` | `5000` | Delay between polls in the facade's submit/poll loop, ms. |

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({
  pluginConfigs: { upscale: { defaultProvider: "fal", pollIntervalMs: 2000 } }
});
```

## The task contract (`contract.ts`)

Self-contained by design: this one file defines what an "upscale provider" is, and it imports no
plugin module. Provider plugins type-import it via
`import type { UpscaleHandler } from "../upscale/contract"` with no `depends` edge. Consumers get
the same types as `Upscale.UpscaleHandler` etc.

### `UpscaleRequest`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `video` | `UpscaleFile` | yes | The source video: `{ path, mimeType, hash }`. |
| `model` | `string` | yes | Provider-scoped model alias, e.g. `"starlight-fast-2"`. Price, endpoint and output depend on it. |
| `factor` | `number` | yes | Upscale factor, 1 to 4 (1.5 turns 720x1280 into 1080x1920). |
| `seconds` | `number` | yes | Source length in seconds; drives the estimate and `costUsd`. |
| `params` | `Record<string, unknown>` | no | Provider params; each provider documents which keys it reads. |

### `UpscaleEstimateRequest`

`UpscaleRequest` with `video` widened to `UpscaleFile | { $ref: string } | { $file: string }`.
Every `UpscaleRequest` is one. `UpscaleHandler.estimate` takes this type.

### `UpscaleResult`

| Field | Type | Description |
|-------|------|-------------|
| `video` | `Uint8Array` | The upscaled video bytes. |
| `mimeType` | `string` | MIME type of `video`, e.g. `video/mp4`. |
| `costUsd` | `number` | Actual cost of this upscale, in US dollars. |
| `meta` | `Record<string, unknown>?` | Metadata only, never a payload echo. |

The runner stores `video` results and maps `video/mp4` to `.mp4`.

### `UpscaleJobPoll`

```ts
type UpscaleJobPoll =
  | { state: "pending" }
  | ({ state: "done" } & UpscaleResult)
  | { state: "failed"; error: unknown };
```

### `UpscaleHandler`

```ts
export type UpscaleHandler = {
  estimate(request: UpscaleEstimateRequest): { usd: number };
  execute?(request: UpscaleRequest, opts: { signal?: AbortSignal }): Promise<UpscaleResult>;
  submit?(request: UpscaleRequest, opts: { signal?: AbortSignal }): Promise<{ jobId: string }>;
  poll?(jobId: string, request: UpscaleRequest, opts: { signal?: AbortSignal }): Promise<UpscaleJobPoll>;
};
```

A value is a valid handler when `estimate` is a function and either `execute` is a function or
both `submit` and `poll` are functions.

## API reference (`app.upscale.*`)

### `generate(request, opts?): Promise<UpscaleResult>`

One-off direct upscale. **NOT journaled**: use `app.runner.run()` for resumability and a durable
cost ledger.

| Param | Type | Description |
|-------|------|-------------|
| `request` | `UpscaleRequest` | The upscale request, with a resolved `video`. |
| `opts.provider` | `string?` | Provider override. Defaults to `config.defaultProvider`. |
| `opts.signal` | `AbortSignal?` | Cancels the provider call or the poll wait. |

- Provider has `execute`: calls it once and returns its result.
- Otherwise: calls `submit` once, then `poll` every `config.pollIntervalMs`.
  - `done`: returns the result without the `state` field.
  - `failed`: throws the poll's `error` as-is.
  - Abort during the wait: rejects at once with the signal's reason.

Unknown or malformed provider:

```
[ai] No upscale provider named "<name>" is registered.
  Available: <comma list or "none">.
```

```ts
const up = await app.upscale.generate({
  video: { path: "out/ep01.mp4", mimeType: "video/mp4", hash: "ab12" },
  model: "starlight-fast-2",
  factor: 1.5,
  seconds: 62.4
});
await Bun.write("ep01-1080.mp4", up.video);
```

### `estimate(request, opts?): { usd: number }`

Cost estimate without executing. Delegates to the handler's own `estimate()`, the same one the
runner's budget gate uses. `video` may be `{ $ref }` or `{ $file }`. Throws the same pinned error
for an unknown provider.

```ts
const { usd } = app.upscale.estimate({
  video: { $ref: "clean" },
  model: "proteus",
  factor: 1.5,
  seconds: 10
});
```

### `providers(): string[]`

Registered upscale providers, in registration order. Delegates to `registry.providers("upscale")`.

```ts
app.upscale.providers(); // => ["fal"]
```

### Module-level export (not on `app.upscale`)

- `isUpscaleHandler(candidate)`: the runtime guard that narrows registry values.

## Events

None.

## Integration

### registry (dependency)

`upscale` declares `depends: [registryPlugin]` and calls `resolve("upscale", provider)` and
`providers("upscale")`. `RegistryApi` is imported from `registry/index.ts` (declared once there) and
re-exported from `types.ts`.

### Provider plugins (fal)

Providers register an `UpscaleHandler` in their `onInit`; `("upscale", "fal")` ships in the package
(Topaz models); the default stays `fal` through `defaultProvider`. A Layer-3 custom provider works
the same way:

```ts
import { createPlugin, registryPlugin } from "@moku-labs/ai";
import type { Upscale } from "@moku-labs/ai";

const handler: Upscale.UpscaleHandler = {
  estimate: request => ({ usd: request.seconds * 0.06 }),
  submit: async request => ({ jobId: await startJob(request) }),
  poll: async jobId => checkJob(jobId)
};

export const acmeUpscalePlugin = createPlugin("acmeUpscale", {
  depends: [registryPlugin],
  onInit: ctx => {
    ctx.require(registryPlugin).register("upscale", "acme", handler);
  }
});
```

### runner (durable path)

The runner accepts `task: upscale` build items with no change. It resolves `video` to
`{ path, mimeType, hash }`, dispatches to the same handlers, prefers `submit`/`poll`, journals the
job id, and on resume polls the live job instead of submitting again.

```yaml
- id: up
  task: upscale
  provider: fal
  input:
    model: starlight-fast-2
    video: { $ref: clean }
    factor: 1.5
    seconds: 62.4
```
