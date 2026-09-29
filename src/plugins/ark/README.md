# ark

> Complex tier. Seedance video (`video/ark`) and portrait assets (`asset/ark`) straight from BytePlus ModelArk (`intl`) or Volcengine Ark (`cn`).

## Purpose

Seedance straight from ByteDance, without a reseller in between. One plugin instance talks to one
region and one account. It registers two handlers with the registry in `onInit`:

- `("video", "ark")`: Seedance text-to-video and image-to-video through the Ark video task API.
  It maps asset refs to `asset://<id>` and checks every asset before any paid call.
- `("asset", "ark")`: registers one portrait into an AIGC asset group through the signed Ark asset
  OpenAPI, and returns an `AssetRecord` (see the [asset README](../asset/README.md)).

Both handlers are `submit` + `poll`, so the runner journals the task or asset id before it waits. A
crash or Ctrl-C resumes by polling the same job, never by paying twice.

ark registers after fal in `src/index.ts`, so fal stays the first video provider and the default for
items that name none. Use `provider: ark` on the items that should go to Ark.

## Regions

| `region` | Service | Data plane (video, Bearer key) | Control plane (assets, signed) | Sign region | Price currency |
| --- | --- | --- | --- | --- | --- |
| `intl` (default) | BytePlus ModelArk | `https://ark.ap-southeast.bytepluses.com/api/v3` | `https://ark.ap-southeast-1.byteplusapi.com` | `ap-southeast-1` | USD |
| `cn` | Volcengine Ark | `https://ark.cn-beijing.volces.com/api/v3` | `https://open.volcengineapi.com` | `cn-beijing` | CNY |

Each region serves only its own model ids. A model from the other region fails before any call:

```
[ai] Model doubao-seedance-2-0-260128 is a cn model.
  Set ark region to "cn" or pick a intl model.
```

## Before the first real run

1. **Keys.** Put them in the shell or in `.env.local` (read through `ctx.env`):

   | Env var | Used for |
   | --- | --- |
   | `ARK_API_KEY` | Video tasks (Bearer). Needed at submit and poll time. |
   | `ARK_ACCESS_KEY` | Asset API (signed with HMAC-SHA256). Needed on the first asset call, and by the video preflight when a request carries an asset ref. |
   | `ARK_SECRET_KEY` | The secret that goes with `ARK_ACCESS_KEY`. |

   A video request without asset refs needs only `ARK_API_KEY`. Estimates and validation need no key.
2. **Seedance Advanced Creation Rights.** The asset API needs this entitlement on the account.
   Without it, the asset calls fail with an `AccessDenied*` or `InvalidAuthorization*` code; the
   error says to check the entitlement.
3. **AIGC authorization letter.** AIGC asset groups need a one-time authorization letter, signed in
   the Ark console.
4. **Group id.** Leave `groupId` unset for the first run. The first registration of the process
   creates a group named `groupName` and logs its id:

   ```
   warn ark:asset:group-created { groupId: "group-20260929120000-abcde", hint: "set ark config groupId to reuse it" }
   ```

   Set `groupId` to that id afterwards. Every process without a `groupId` creates a new group, and an
   account holds at most 50 groups.

## Configuration

Set via `createApp({ pluginConfigs: { ark: { ... } } })`.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `region` | `"intl" \| "cn"` | `"intl"` | BytePlus ModelArk or Volcengine Ark. |
| `apiKeyEnv` | `string` | `"ARK_API_KEY"` | Env var of the API key (video tasks). |
| `accessKeyEnv` | `string` | `"ARK_ACCESS_KEY"` | Env var of the access key id (asset API). |
| `secretKeyEnv` | `string` | `"ARK_SECRET_KEY"` | Env var of the secret access key. |
| `baseUrl` | `string \| null` | `null` | Data-plane URL override (proxies, tests). `null` = the region's. |
| `controlUrl` | `string \| null` | `null` | Control-plane URL override. `null` = the region's. |
| `groupId` | `string \| null` | `null` | AIGC asset group. `null` = create one per process and log its id. |
| `groupName` | `string` | `"moku-ai"` | Name of the group created when `groupId` is `null`. |
| `timeoutMs` | `number` | `60_000` | Timeout of one HTTP request. |
| `priceOverrides` | `Record<string, number>` | `{}` | USD per 1M output tokens, by model id. Wins over the catalog. |
| `cnyPerUsd` | `number` | `7.1` | CNY per 1 USD, to report cn prices in USD. |

```ts
const app = createApp({
  pluginConfigs: { ark: { region: "intl", groupId: "group-20260929120000-abcde" } }
});
```

## Models

`input.model` must be one of these ids, for the configured region. Any other id fails:
`[ai] Unknown ark model "<id>".\n  Known: <list>.`

| Model | Region | Max clip per generation | Resolutions | Refs img / vid / aud | Price per 1M output tokens (base / with video input) |
| --- | --- | --- | --- | --- | --- |
| `dreamina-seedance-2-0-260128` | intl | 15 s | 480p, 720p, 1080p | 9 / 3 / 3 | $7.0 / $4.3, verify in console |
| `dreamina-seedance-2-5-260628` | intl | 30 s | 480p, 720p | 30 / 10 / 10 | $10.7 / $6.4, verify in console |
| `doubao-seedance-2-0-260128` | cn | 15 s | 480p, 720p, 1080p | 9 / 3 / 3 | ¥46 / ¥28, verify in console |
| `doubao-seedance-2-5-260628` | cn | 30 s | 480p, 720p | 30 / 10 / 10 | ¥70 / ¥42, verify in console |

- The shortest clip is 4 s on every row. `seconds` defaults to 5, `resolution` to `720p`.
- The ids and prices come from summaries of the official rate cards, not from the rate cards
  themselves. Each row in `models.ts` carries its `// source:`. Check them in the console before a
  paid run, and fix a price with `priceOverrides`.
- No row takes a seed. Every row can generate audio (`audio: true` → `generate_audio`).

## Video handler

`POST {dataPlane}/contents/generations/tasks`, then `GET .../tasks/{id}` until the task ends.

| `VideoRequest` | Ark body |
| --- | --- |
| `model` | `model`, checked against the catalog and the region |
| `prompt` | `content[0] = { type: "text", text }`, sent as written |
| `image` | `image_url`, `role: "first_frame"` |
| `endImage` | `image_url`, `role: "last_frame"` |
| `refs` (images and assets) | `image_url`, `role: "reference_image"`, in request order |
| `seconds` | `duration`, within the model's limits |
| `aspect` | `ratio`: `16:9`, `9:16` (default), `1:1`, `4:3`, `3:4`, `21:9` or `adaptive` |
| `resolution` | `resolution`, one of the model's |
| `audio` | `generate_audio` |
| `negative` | Not supported by Ark. Dropped, with one `ark:negative:ignored` warning per process |

A local image goes out as `data:<mime>;base64,...`. A `$ref` to an `asset` item goes out as
`asset://<assetId>`. Image refs and asset refs count together against the model's image limit. The
prompt cites refs by position ("image 1"); the handler never rewrites it.

### Params

`params` is an allowlist. Any other key fails:
`[ai] Unknown ark param "<key>".\n  Allowed: refUrls, watermark, seed, return_last_frame, execution_expires_after, priority.`

| Param | Meaning |
| --- | --- |
| `refUrls` | Video and audio references, as public https URLs. See below. |
| `watermark` | Passed through. Default `false`. |
| `seed` | Passed through only on a model that takes a seed. No v1 model does, so it fails. |
| `return_last_frame` | Passed through. The last frame URL comes back in `meta.lastFrameUrl`. |
| `execution_expires_after` | Passed through. |
| `priority` | Passed through. |

**`refUrls`: video and audio refs by URL.** Ark takes base64 only for images. Video and audio
references must be public https URLs, and the caller hosts the files: ark never uploads them. The
kind comes from the URL path: `.mp4` / `.mov` is a reference video, `.mp3` / `.wav` is a reference
audio. They go after the image refs, in array order, and count against the model's video and audio
limits.

```yaml
  - id: clip-02
    task: video
    provider: ark
    input:
      model: dreamina-seedance-2-5-260628
      prompt: "image 1 walks down the street to the beat of audio 1"
      refs: [{ $ref: face-mira }]
      seconds: 10
    params:
      refUrls: ["https://cdn.example/motion/walk.mp4", "https://cdn.example/audio/rain.mp3"]
```

A video or audio file in `refs` fails before any call:

```
[ai] ark takes video and audio references by public URL only.
  Pass them in params.refUrls.
```

### Asset preflight

Before the POST, every asset ref is checked. The POST happens only when all checks pass, so no
money is spent on a bad asset:

1. The record was registered by ark. Otherwise:
   `[ai] Asset "<assetId>" was registered by "<provider>", not ark.\n  Register the portrait with provider ark.`
2. The record belongs to this account (see [Account fingerprint](#account-fingerprint)). Otherwise:
   `[ai] Asset "<assetId>" belongs to another ark account.\n  Register the portrait again with this account's keys.`
3. `GetAsset` says `Active`. Otherwise:
   `[ai] ark asset "<assetId>" is <Status>.\n  Bump params.generation on its asset item to register again.`

An asset seen `Active` is not checked again in the same process.

### Face refusal

Ark refuses a plain photo that may show a real person (`InputImageSensitiveContentDetected.*`). The
item is `flagged`, and the message depends on the request:

- The request has a plain local image (`image`, `endImage` or a ref that is not an asset):

  ```
  [ai] ark refused an image with a face: <code>.
    Make it an asset item and $ref it.
  ```

- Otherwise: `[ai] ark flagged the request: <code>.\n  Change the prompt or the inputs.`

**There is no raw-photo fallback, and no registration after a refusal.** Register the portrait
first, in an `asset` item. After a refusal, ark could not register the face anyway: `CreateAsset`
needs a public https URL, and a video request only has local files. A refused task is not billed.

### Poll and cost

| Task status | Result |
| --- | --- |
| `queued`, `running` | pending |
| `succeeded` | Download `content.video_url` at once (it expires 24 h after success). Done, `video/mp4`. |
| `failed` with a `SensitiveContent` code | failed, flagged |
| `failed`, other code | failed, terminal (400) with Ark's code and message |
| `expired`, `cancelled` | failed, terminal (410) |

Cost = `usage.completion_tokens / 1e6 × price`. The price is the "with video input" one when
`refUrls` holds a video URL, the base one otherwise. `priceOverrides[model]` (USD) wins. cn prices
are divided by `cnyPerUsd`. The estimate is `width × height × 24 × seconds / 1024` tokens at the
base price (480p 864×480, 720p 1280×720, 1080p 1920×1080). Example: `dreamina-seedance-2-0-260128`,
5 s at 720p = 108,000 tokens = $0.756.

`meta` is `{ taskId, model, seconds, resolution, completionTokens, lastFrameUrl? }`.

## Asset handler

An `asset` item registers one portrait. Estimate is $0: the asset fee is part of the entitlement.

**The item needs a public https `url`** of the same bytes as `image`. `CreateAsset` fetches the
portrait from that URL; ark never uploads it. `url` is part of the artifact key, so a new URL
registers again. Without it, the item fails before any call:

```
[ai] ark CreateAsset needs a public https url.
  Pass input.url with the same bytes as input.image.
```

```yaml
  - id: face-mira
    task: asset
    provider: ark
    input:
      image: { $file: faces/mira.png }
      url: "https://cdn.example/faces/mira.png"
```

Submit, in order, with every check before the first call:

1. `group` must be `"aigc"` or absent.
2. `url` must be a https URL.
3. The local image must be PNG, JPEG or WebP, under 30 MB, 300 to 6000 px on each side, with a
   width/height ratio of 0.4 to 2.5. The size is read from the file header.
4. The group: `groupId`, or one `CreateAssetGroup { GroupType: "AIGC", Name: groupName }` per process.
5. `CreateAsset { GroupId, URL, AssetType: "Image", Name }`. `Name` is `name`, else the file's base name.

Poll is `GetAsset { Id }`: `Processing` is pending, `Active` is done with the record, `Failed` is
flagged:

```
[ai] ark refused asset "<name>": <FailedReason>.
  Items that use it will not run.
```

Every item that `$ref`s a refused asset stays queued and is never dispatched. Nothing retries a
refused registration.

### A dead asset: bump `params.generation`

A stored record is reused as long as the item's input is unchanged. When the asset was deleted in the
console, or the preflight reports it as not `Active`, bump `params.generation` on the asset item. The
new key registers the portrait again, and the clips that use it render again:

```yaml
  - id: face-mira
    task: asset
    provider: ark
    input:
      image: { $file: faces/mira.png }
      url: "https://cdn.example/faces/mira.png"
    params: { generation: 2 }
```

## Account fingerprint

An asset id is valid only in the account that registered it. The record carries a fingerprint of
that account:

```
account = sha256("moku-ai:" + region + ":" + accessKey).slice(0, 12)
```

It is one-way: it never contains the key and cannot be turned back into it. The region is part of
it, because the same key in two regions is two accounts. Two IAM users of one account get two
fingerprints. That errs on the safe side: a mismatch fails the item before any call, it never sends
a request to the wrong account. When the keys change, bump `params.generation` on the asset items
to register the portraits in the new account.

## Errors

| Condition | Result |
| --- | --- |
| Caller abort | Rethrown unchanged (clean pause). A task POST already sent runs to the end, so a billed task always returns its id |
| Request timeout / network failure | Retryable, `kind: "timeout"` / `"network"` |
| HTTP 429 | Retryable, `status: 429`, `Retry-After` honored (seconds or HTTP date) |
| HTTP 5xx | Retryable, `status` |
| HTTP 400 / 422 with a `SensitiveContent` code | Flagged (see [Face refusal](#face-refusal)) |
| Other HTTP 4xx | Terminal: `[ai] ark <Action or path> failed (<status> <code>): <message>.` |
| Asset API `Throttling*`, `RequestLimitExceeded*`, `FlowLimitExceeded*`, `TooManyRequests*` | Retryable, `status: 429` |
| Asset API `QuotaExceeded`, `AccessDenied*`, `InvalidAuthorization*` | Terminal, with a hint to check the entitlement and the authorization letter |
| Other asset API error | Terminal |
| A key not set, unknown model or param, bad seconds, resolution, ratio or ref count, bad `url` or image | Plain two-line error before any call: terminal after one attempt, nothing billed |

Messages start with `[ai]` and never contain a key or a signed URL. Logs carry
ids, codes and statuses only: `ark:video:submitted`, `ark:video:done`, `ark:video:failed`,
`ark:asset:group-created`, `ark:asset:registered`, `ark:asset:refused`, `ark:negative:ignored`.

## API

```ts
app.ark.info();
// => { provider: "ark", region: "intl", configured: { video: true, assets: false },
//      models: ["dreamina-seedance-2-0-260128", "dreamina-seedance-2-5-260628"] }
```

No network call. `configured.video` is true when the API key is set, `configured.assets` when both
the access key and the secret key are set. `models` lists the configured region's ids.

## Usage

```yaml
version: 1
name: mira
items:
  - id: face-mira
    task: asset
    provider: ark
    input: { image: { $file: faces/mira.png }, url: "https://cdn.example/faces/mira.png" }
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

One-off, outside the runner (not journaled, not cached):

```ts
import { ASSET_MIME, encodeAssetRecord } from "@moku-labs/ai";

const image = { path: "faces/mira.png", mimeType: "image/png", hash: "a".repeat(64) };
const record = await app.asset.register({ image, url: "https://cdn.example/faces/mira.png" }, { provider: "ark" });

await Bun.write("mira.asset.json", encodeAssetRecord(record));
const asset = { path: "mira.asset.json", mimeType: ASSET_MIME, hash: "b".repeat(64) };
const clip = await app.video.generate(
  { model: "dreamina-seedance-2-0-260128", prompt: "image 1 walks into the rain", image: asset },
  { provider: "ark" }
);
// => { video: Uint8Array, mimeType: "video/mp4", costUsd: 0.7623, meta: { taskId, ... } }
```

## Tests

All tests are local. `fetch` is mocked and nothing reaches Ark. The fixtures in
`__tests__/fixtures.ts` are copies of documented request and response examples, each with its
`// source:`: the ark-mcp repository (`github.com/byteplus-sa/ark-mcp`: the asset library contract
spec, the Seedance adapter and its contract tests, the OpenAPI signing script) and a real failed-task
body from a public issue. A field no source confirms carries an `// unverified:` note. Built request
bodies are compared with `toEqual` against those examples, so drift from the docs fails a test. The
integration test runs the full framework: one asset item and two clips on mocked fetch, reuse on a
second run, a refused asset that blocks both clips, and both facades.
