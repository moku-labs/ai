# asset

> Standard tier. Owner of the "asset" task contract: register one portrait with a provider and get back an opaque `AssetRecord`, plus the one-off facade `app.asset.*`.

## Purpose

Some video providers refuse a plain photo of a real face. They take the same face when it is
registered first, as an asset in the provider's own account, and the video request names the asset
id instead of sending the image. `asset` is the task plugin for that registration step. It owns
the contract every asset provider implements (`contract.ts`) and a small typed facade, `app.asset.*`.

**Registration is its own step.** An `asset` item runs before any video item that uses it. It is
not a retry after a refusal: no provider registers a face on the fly, and no provider falls back to
sending the raw photo. This keeps the flow simple and the cost visible:

- The runner orders it. A video item `$ref`s the asset item, so the asset runs first.
- The runner caches it. The done asset is an artifact like any other. A second run, or a second
  clip with the same face, reuses it at $0.
- The runner journals it. Registration is async upstream (submit, then poll until the asset is
  active), so the job id is journaled and a crash resumes by polling, never by registering twice.
- A refusal blocks early. A refused portrait flags the asset item, and every item that `$ref`s it
  is never dispatched. Nothing is paid for a clip that would be refused.

The plugin is stateless: no `state.ts`, no lifecycle, no events. There are no new tables and no new
runner code: the only runner change is one MIME entry, so a stored record exports as `.json`.

## Configuration

Set under `pluginConfigs.asset` in `createApp`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultProvider` | `string` | `"ark"` | Provider used by the facade when the caller names none. |
| `pollIntervalMs` | `number` | `3000` | Delay between polls in the facade's submit/poll loop, ms. Ark's guidance is to poll every 3 s. |

The runner does not read this config. In a build file the provider comes from the item, and the
runner polls every `runner.pollIntervalMs`.

## The task contract (`contract.ts`)

Self-contained by design: this one file defines what an "asset provider" is, and it imports
nothing. Provider plugins import it as `import type { AssetHandler } from "../asset/contract"`,
plus the values `ASSET_MIME`, `encodeAssetRecord` and `parseAssetRecord`. Consumers get the types
as `Asset.AssetRequest` etc., and the three values from the package root.

### `ASSET_MIME`

```ts
export const ASSET_MIME = "application/vnd.moku.asset+json";
```

The MIME type of a stored `AssetRecord`. When the runner resolves a `$ref` to a done asset item, the
handler gets a file with this MIME type. That is how a video provider tells an asset from an
image. A `.json` `$file` stays `application/json`: it never becomes an asset. On export, the record
is written as `<label>.json`.

### `AssetRequest`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `image` | `AssetFile` | yes | The portrait file. Its sha256 `hash` is part of the artifact key, so the same bytes register once. |
| `url` | `string` | no | Public https URL of the same bytes, for providers whose register API only fetches URLs (Ark). A provider that needs it and gets none fails before any call. |
| `group` | `"aigc"` | no | Group kind. Default `"aigc"`, the only kind in v1. |
| `name` | `string` | no | Display name sent to the provider, max 64 characters. Default: the file's base name. |
| `params` | `Record<string, unknown>` | no | Free provider params. `generation` (a number) is the re-register knob, see below. |

`AssetFile` is `{ path: string; mimeType: string; hash: string }`, the same shape as the runner's
resolved file.

### `AssetRecord`

The opaque result, stored as the artifact under `ASSET_MIME`.

| Field | Type | Description |
|-------|------|-------------|
| `assetId` | `string` | Provider asset id. Ark sends it as `asset://<assetId>`. |
| `provider` | `string` | Provider that registered it, e.g. `"ark"`. |
| `account` | `string` | Provider-computed, one-way account fingerprint. The id is valid only in this account. |
| `groupId` | `string` | Provider group the asset lives in. |
| `registeredAt` | `number` | Epoch ms when the provider reported the asset active. |

### `AssetResult`, `AssetJobPoll`, `AssetHandler`

```ts
type AssetResult = {
  body: Uint8Array;               // encodeAssetRecord(record)
  mimeType: typeof ASSET_MIME;
  costUsd: number;
  meta?: { assetId: string; account: string };
};

type AssetJobPoll =
  | { state: "pending" }
  | ({ state: "done" } & AssetResult)
  | { state: "failed"; error: unknown };

type AssetHandler = {
  estimate(request: AssetRequest): { usd: number };
  submit(request: AssetRequest, opts: { signal?: AbortSignal }): Promise<{ jobId: string }>;
  poll(jobId: string, request: AssetRequest, opts: { signal?: AbortSignal }): Promise<AssetJobPoll>;
};
```

One shape serves both consumers. A done poll is in the runner's handler-result shape, so the runner
stores `body` unchanged. The facade parses the same `body` with `parseAssetRecord`. There is no
`execute`: registration is async upstream, so every provider implements `submit` + `poll`.

A refused registration is a `failed` poll (or a throw) whose error carries
`kind: "content-policy"`. The runner flags the item.

### `encodeAssetRecord` / `parseAssetRecord`

`encodeAssetRecord(record)` writes UTF-8 JSON with a stable key order (`assetId`, `provider`,
`account`, `groupId`, `registeredAt`) and drops extra keys. `parseAssetRecord(bytes)` reads it back
and checks every field:

```
[ai] Not an asset record: <reason>.
  Expected JSON with assetId, provider, account, groupId, registeredAt.
```

`<reason>` is `invalid JSON`, `not a JSON object`, `missing "<key>"`, `"<key>" must be a non-empty
string` or `"registeredAt" must be a finite number`.

## Build files

Register the portrait in an `asset` item, then `$ref` it from the video items:

```yaml
version: 1
name: mira
items:
  - id: face-mira
    task: asset
    provider: ark
    input:
      image: { $file: faces/mira.png }
      url: "https://cdn.example/faces/mira.png"
  - id: clip-01
    task: video
    provider: ark
    input:
      model: dreamina-seedance-2-5-260628
      prompt: "image 1 walks into the rain"
      refs: [{ $ref: face-mira }]
      seconds: 10
      resolution: 720p
      aspect: "9:16"
```

- `face-mira` runs first. Its artifact is the `AssetRecord` JSON.
- `clip-01` gets a ref with `mimeType === ASSET_MIME`. The video provider reads the record and
  sends the asset id, not the photo.
- A second run reuses both items at $0. So does another build file with the same face and URL.
- If the provider refuses the portrait, `face-mira` is `flagged` and `clip-01` stays queued: it is
  never dispatched (the runner logs `runner:blocked`).
- A video provider that cannot use assets refuses the ref before any upload. fal does this.

### Register again: `params.generation`

The artifact key covers the image hash, `url`, `name`, `group` and `params`. Unchanged input means
the stored record is reused, even when the provider has since deleted the asset or reports it as
not active. To register the same portrait again, bump `params.generation`:

```yaml
  - id: face-mira
    task: asset
    provider: ark
    input:
      image: { $file: faces/mira.png }
      url: "https://cdn.example/faces/mira.png"
    params: { generation: 2 }
```

The new key misses the cache, so the item registers again. Every video item that `$ref`s it gets a
new key too, so those clips render again with the new asset.

## Providers

| Provider | Plugin | Notes |
|----------|--------|-------|
| `ark` | [`ark`](../ark/README.md) | BytePlus ModelArk (`intl`) or Volcengine Ark (`cn`). Needs the public https `url`. Estimate is $0. |

A custom provider registers an `AssetHandler` under task `"asset"` in `onInit`, like every other
task provider:

```ts
import { createPlugin, registryPlugin, ASSET_MIME, encodeAssetRecord } from "@moku-labs/ai";
import type { Asset } from "@moku-labs/ai";

const handler: Asset.AssetHandler = {
  estimate: () => ({ usd: 0 }),
  submit: async request => ({ jobId: await acmeUpload(request.image.path) }),
  poll: async jobId => {
    const asset = await acmeStatus(jobId);
    if (!asset.ready) return { state: "pending" };
    const record = { assetId: asset.id, provider: "acme", account: acmeAccount(), groupId: "default", registeredAt: Date.now() };
    return { state: "done", body: encodeAssetRecord(record), mimeType: ASSET_MIME, costUsd: 0 };
  }
};

export const acmeAssetsPlugin = createPlugin("acmeAssets", {
  depends: [registryPlugin],
  onInit: ctx => {
    ctx.require(registryPlugin).register("asset", "acme", handler);
  }
});
```

## API reference (`app.asset.*`)

### `register(request, opts?): Promise<AssetRecord>`

One-off registration outside the runner. **NOT journaled and NOT cached**: prefer an `asset` item
in a build file.

| Param | Type | Description |
|-------|------|-------------|
| `request` | `AssetRequest` | The portrait to register. |
| `opts.provider` | `string?` | Provider override. Defaults to `config.defaultProvider`. |
| `opts.signal` | `AbortSignal?` | Cancels the provider calls and the poll wait. |

- Calls `submit` once, then `poll` every `config.pollIntervalMs`.
- `done`: parses `body` with `parseAssetRecord` and returns the record.
- `failed`: throws the poll's `error` unchanged.
- Abort during the wait: rejects at once with the signal's reason.

```ts
const image = { path: "faces/mira.png", mimeType: "image/png", hash: "a".repeat(64) };
const record = await app.asset.register({ image, url: "https://cdn.example/faces/mira.png" }, { provider: "ark" });
// => { assetId: "asset-2026...", provider: "ark", account: "1aea36531116", groupId: "group-...", registeredAt: 1790000000000 }
```

### `estimate(request, opts?): { usd: number }`

Cost estimate from the provider handler. Ark registers assets at no charge, so it returns `0`.

```ts
app.asset.estimate({ image }); // => { usd: 0 }
```

### `providers(): string[]`

Registered asset providers, in registration order. Delegates to `registry.providers("asset")`.

```ts
app.asset.providers(); // => ["ark"]
```

### Module-level export (not on `app.asset`)

- `isAssetHandler(candidate)`: the runtime guard of the one audited cast. It checks that
  `estimate`, `submit` and `poll` are all functions.

## Errors

| Condition | Error |
|-----------|-------|
| Unknown provider, or a registered value that fails `isAssetHandler` | `[ai] No asset provider named "<name>" is registered.\n  Available: <comma list or "none">.` |
| Stored bytes are not a record | `[ai] Not an asset record: <reason>.\n  Expected JSON with assetId, provider, account, groupId, registeredAt.` |
| Provider refused the portrait | The provider's flagged error (`kind: "content-policy"`), thrown by `register`; the item is `flagged` in a run |
| Abort | The signal's reason |

## Events

None.

## Integration

### registry (dependency)

`asset` declares `depends: [registryPlugin]` and calls `resolve("asset", provider)` and
`providers("asset")`. It is registered after `video` in `src/index.ts`.

### runner (durable path)

The runner drives the same handler through `submit` + `poll`, stores the done `body` under
`ASSET_MIME`, and resolves a `$ref` to it as a file with that MIME type.
