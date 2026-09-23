# image

> Owner of the "image" task contract and the typed one-off facade `app.image.*` — any registered provider, one audited cast, zero state.

## Purpose

`image` is the task plugin for still images in the `@moku-labs/ai` build system. It owns the
capability contract (`contract.ts`) that every image provider implements — `ImageFile`,
`ImageRequest`, `ImageResult`, and `ImageHandler` — and exposes a small typed facade,
`app.image.*`, for one-off generation, cost estimation, and provider discovery. Provider plugins
(e.g. `codex`, `fal`) implement `ImageHandler` and register it with the `registry` plugin under the
`"image"` task.

The registry transports handlers as `unknown`, so this plugin performs the ONE audited cast for the
image task (spec/09 R9): `api.ts` narrows the opaque value back to `ImageHandler` behind a runtime
shape guard. A malformed registration fails with a descriptive error, never a crash. The plugin is
a stateless facade — no `state.ts`, no lifecycle hooks, no events, no packs.

The runner never calls this facade. It drives registered handlers directly (spec 06).

## Configuration

Set under `pluginConfigs.image` in `createApp`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultProvider` | `string` | `"codex"` | Provider used when a call doesn't name one via `opts.provider`. |

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({
  pluginConfigs: { image: { defaultProvider: "fal" } }
});
```

## The task contract (`contract.ts`)

Self-contained by design — no shared base type is imported from elsewhere. Provider plugins
type-import it via `import type { ImageHandler } from "../image/contract"`.

### `ImageFile`

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | Path of the resolved local file. |
| `mimeType` | `string` | MIME type of the file. |
| `hash` | `string` | Content hash; artifact identity follows the bytes. |

### `ImageRequest`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | `string` | yes | What to draw. The caller already appended the series style. |
| `negative` | `string` | no | Things to avoid. |
| `model` | `string` | no | Provider-scoped model id. |
| `aspect` | `string` | no | Aspect ratio, e.g. `"9:16"`. Providers default to `"9:16"`. |
| `refs` | `ImageFile[]` | no | Reference images (character sheet, location plate, earlier keyframe). |
| `params` | `Record<string, unknown>` | no | Pass-through provider params. |

### `ImageResult`

| Field | Type | Description |
|-------|------|-------------|
| `image` | `Uint8Array` | The generated image bytes. |
| `mimeType` | `string` | MIME type of `image`. |
| `costUsd` | `number` | Actual cost of this generation, in US dollars. |
| `meta` | `Record<string, unknown>?` | Metadata only, never a payload echo. |

### `ImageHandler`

```ts
export type ImageHandler = {
  estimate(request: ImageRequest): { usd: number };
  execute(request: ImageRequest, opts: { signal?: AbortSignal }): Promise<ImageResult>;
};
```

## API reference (`app.image.*`)

### `generate(request, opts?): Promise<ImageResult>`

One-off generation. Resolves `opts.provider ?? config.defaultProvider`, performs the audited cast,
and calls `handler.execute(request, { signal })`. The request is passed through unchanged.

**NOT journaled.** No resumability, no cost-ledger entry. Use `app.runner.run()` for durable work.

| Param | Type | Description |
|-------|------|-------------|
| `request` | `ImageRequest` | The image request. |
| `opts.provider` | `string?` | Provider override; defaults to `config.defaultProvider`. |
| `opts.signal` | `AbortSignal?` | Abort signal passed through to the handler. |

Unknown or malformed provider:

```
[ai] No image provider named "<name>" is registered.
  Available: <comma list or "none">.
```

### `estimate(request, opts?): { usd: number }`

Delegates to the resolved handler's `estimate()`. Same provider resolution and same error.

### `providers(): string[]`

Registered image providers. `config.defaultProvider` comes first when registered, then the rest
in registration order.

## Events

None.

## Usage

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({});
await app.start();

const { image, costUsd } = await app.image.generate({
  prompt: "a patisserie at night",
  aspect: "9:16"
});
await Bun.write("patisserie.png", image);

app.image.estimate({ prompt: "a patisserie at night" }, { provider: "fal" });
app.image.providers(); // => ["codex", "fal"]

await app.stop();
```

## Integration

### registry (dependency)

`depends: [registryPlugin]`, reached via `ctx.require(registryPlugin)` — `resolve("image", provider)`
in `generate()`/`estimate()` and `providers("image")` in `providers()`. `RegistryApi` is imported
from `registry/index.ts` (declared once there) and re-exported from `types.ts`.

### Provider plugins (codex, fal)

Providers build an `ImageHandler` in `onInit` and call
`ctx.require(registryPlugin).register("image", "<name>", handler)`. This plugin never imports a
provider.
