# sprite

> Owner of the "sprite" task contract, the typed one-off facade `app.sprite.*`, and the pure pixel step `processSprite`. Execute-only providers, one runtime guard, zero state.

## Purpose

`sprite` is the task plugin for game sprites in the `@moku-labs/ai` build system. A sprite item takes
an existing image by `$ref` or `$file` and returns a transparent RGBA PNG. The steps are background
removal (the provider's matte model), trim to the alpha bounds, optional padding, and an optional
resize to a target size.

The plugin owns three things:

- the capability contract (`contract.ts`): `SpriteFile`, `SpriteRequest`, `SpriteResult`, `SpriteHandler`;
- the facade `app.sprite.*` for one-off cuts, cost estimates and provider discovery;
- `processSprite` (`process.ts`), the pixel step every provider runs after its matte call.

A sprite takes two build items: an `image` item makes the raw picture, and a `sprite` item takes it
by `$ref` and cuts it. Changing the sprite options re-cuts the stored image and never regenerates it.

The registry transports handlers as `unknown`. `api.ts` narrows them for the sprite task (spec/09 R9)
with the runtime guard `isSpriteHandler`, with no cast. A malformed registration fails with the
pinned error, never a crash. The plugin is stateless: no `state.ts`, no lifecycle, no events.
`sharp` is used per call and holds no resource.

`SpriteRequest.model` is required. The runner hashes the build item's input as written, so a model
defaulted inside a provider would not be part of the artifact key.

## Configuration

Set under `pluginConfigs.sprite` in `createApp`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultProvider` | `string` | `"fal"` | Provider used by the facade when the caller names none. |

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({ pluginConfigs: { sprite: { defaultProvider: "fal" } } });
```

## The task contract (`contract.ts`)

Self-contained by design: this one file defines what a "sprite provider" is, and it imports no
plugin module. Provider plugins type-import it via
`import type { SpriteHandler } from "../sprite/contract"` with no `depends` edge.

### `SpriteRequest`

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `source` | `SpriteFile` | yes | | The source image. The runner resolves `{ $ref: id }` / `{ $file: path }` into `{ path, mimeType, hash }`. |
| `model` | `string` | yes | | Matte model alias, e.g. `"birefnet"`. `"none"` means the source is already transparent. |
| `trim` | `boolean` | no | `true` | Trim to the alpha bounding box. |
| `padding` | `number` | no | `0` | Transparent padding kept around the trimmed box, px. |
| `size` | `{ width, height }` | no | size after trim | Target size, px. |
| `fit` | `"contain" \| "cover" \| "fill"` | no | `"contain"` | How the image fits `size`. `contain` letterboxes with transparent pixels. |
| `pixelArt` | `boolean` | no | `false` | Nearest-neighbour resize. Otherwise lanczos3. |
| `alphaThreshold` | `number` | no | `8` | Alpha at or below this value counts as empty, 0..255. |
| `params` | `Record<string, unknown>` | no | | Provider params; each provider documents which keys it reads. |

### `SpriteResult`

| Field | Type | Description |
|-------|------|-------------|
| `image` | `Uint8Array` | The RGBA PNG bytes. |
| `mimeType` | `"image/png"` | Always a PNG. The runner exports it as `<label>.png`. |
| `costUsd` | `number` | Actual cost of this cut, in US dollars. |
| `meta` | `Record<string, unknown>?` | `width`, `height`, `trimBox`, `model`. Metadata only. |

### `SpriteHandler`

```ts
export type SpriteHandler = {
  estimate(request: SpriteRequest): { usd: number };
  execute(request: SpriteRequest, opts: { signal?: AbortSignal }): Promise<SpriteResult>;
};
```

A value is a valid handler when both `estimate` and `execute` are functions. There is no
submit/poll form. `estimate` reads `model` only: the runner estimates before `source` is resolved.

## The pixel step (`process.ts`)

```ts
processSprite(png: Uint8Array, options: SpriteProcessOptions): Promise<ProcessedSprite>
// ProcessedSprite = { image: Uint8Array; width: number; height: number; trimBox: TrimBox }
```

`SpriteProcessOptions` has the pixel fields of `SpriteRequest`, so a provider passes its whole
request. The module imports only `sharp`. Providers import it at runtime (decision D6); it is a
function module, not a plugin, so no `depends` edge appears.

1. Input checks run before any work: `size` must be whole pixels of at least 1, `padding` a whole
   number of 0 or more, `alphaThreshold` in 0..255, `fit` one of the three values.
2. The image is decoded to raw RGBA; an alpha channel is added when missing.
3. The bounding box of pixels with alpha above `alphaThreshold` is found by scanning the buffer.
   An image with no such pixel throws, with `trim: false` too:
   ```
   [ai] Sprite is empty after background removal.
     Check the source image or lower alphaThreshold.
   ```
4. Unless `trim` is `false`, the image is cut to that box. `trimBox` is the box kept; with
   `trim: false` it is the whole image.
5. `padding` adds transparent pixels on every side.
6. `size` resizes the padded image, so the output is exactly `size`. `fit` maps to sharp's fit;
   `contain` uses a transparent background. The kernel is `nearest` with `pixelArt`, else `lanczos3`.
7. The output is an RGBA PNG, `compressionLevel: 9`.

```ts
// A matte model returned a 32x32 picture with a 10x6 button at (5,7).
const cut = await processSprite(mattePng, { padding: 1 });
// cut.width === 12, cut.height === 8, cut.trimBox => { left: 5, top: 7, width: 10, height: 6 }
```

## API reference (`app.sprite.*`)

### `generate(request, opts?): Promise<SpriteResult>`

One-off direct cut: calls the provider's `execute` once and returns its result. **NOT journaled**:
use `app.runner.run()` for resumability and a durable cost ledger.

| Param | Type | Description |
|-------|------|-------------|
| `request` | `SpriteRequest` | The sprite request, with `source` already a file. |
| `opts.provider` | `string?` | Provider override. Defaults to `config.defaultProvider`. |
| `opts.signal` | `AbortSignal?` | Forwarded to the provider's `execute`. |

Unknown or malformed provider:

```
[ai] No sprite provider named "<name>" is registered.
  Available: <comma list or "none">.
```

```ts
const sprite = await app.sprite.generate({
  source: { path: "art/icon.png", mimeType: "image/png", hash: "icon" },
  model: "none",
  size: { width: 64, height: 64 },
  pixelArt: true
});
await Bun.write("icon.png", sprite.image);
```

### `estimate(request, opts?): { usd: number }`

Cost estimate without executing. Delegates to the handler's own `estimate()`, the same one the
runner's budget gate uses. Throws the same pinned error for an unknown provider.

```ts
app.sprite.estimate({ source: iconFile, model: "none" }); // => { usd: 0 } with fal
```

### `providers(): string[]`

Registered sprite providers, in registration order. Delegates to `registry.providers("sprite")`.

```ts
app.sprite.providers(); // => ["fal"]
```

### Module-level exports (not on `app.sprite`)

- `isSpriteHandler(candidate)` (`api.ts`): the runtime guard that narrows registry values.
- `processSprite(png, options)` (`process.ts`): the pixel step, for provider handlers.

## Events

None.

## Integration

### registry (dependency)

`sprite` declares `depends: [registryPlugin]` and calls `resolve("sprite", provider)` and
`providers("sprite")`. `RegistryApi` is imported from `registry/index.ts` and re-exported from
`types.ts`.

### Provider plugins (fal)

Providers register a `SpriteHandler` in their `onInit`; the first is `("sprite", "fal")`. A handler
runs its matte model, then `processSprite`. Inside this package a provider imports the pixel step
from `../../sprite/process`. The `none` model skips the matte:

```ts
import { readFile } from "node:fs/promises";
import type { SpriteHandler } from "../../sprite/contract";
import { processSprite } from "../../sprite/process";

const handler: SpriteHandler = {
  estimate: request => ({ usd: request.model === "none" ? 0 : 0.002 }),
  execute: async request => {
    const bytes = await readFile(request.source.path); // after the matte call for other models
    const cut = await processSprite(bytes, request);
    return { image: cut.image, mimeType: "image/png", costUsd: 0, meta: { trimBox: cut.trimBox } };
  }
};
// onInit: ctx.require(registryPlugin).register("sprite", "fal", handler);
```

### runner and buildfile (durable path)

The runner accepts `task: sprite` build items with no change. It resolves `source` to a stored
file, calls `execute`, and exports the PNG as `<label>.png`. A nine-slice hint lives in the item id
and so in the filename: `btn{nine=12,12,12,12}` exports `btn{nine=12,12,12,12}.png`. `buildfile`
validates the hint syntax (decision D4); this plugin does not read it.

```yaml
- task: image
  id: btn-raw
  input: { prompt: "wooden game UI button, flat colour background", aspect: "1:1" }
- task: sprite
  id: "btn{nine=12,12,12,12}"
  input: { source: { $ref: btn-raw }, model: birefnet, size: { width: 128, height: 64 }, padding: 2 }
```
