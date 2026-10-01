# ark

> Complex tier. Seedance video (`video/ark`), Seedream images (`image/ark`) and portrait assets (`asset/ark`) straight from BytePlus ModelArk (`intl`) or Volcengine Ark (`cn`).

## Purpose

Seedance and Seedream straight from ByteDance, without a reseller in between. One plugin instance
talks to one region and one account. It registers three handlers with the registry in `onInit`:

- `("video", "ark")`: Seedance text-to-video and image-to-video through the Ark video task API.
  It maps asset refs to `asset://<id>` and checks every asset before any paid call. It also makes
  cheap 480p drafts and renders a draft again at 1080p ([Draft → final](#draft--final)).
- `("image", "ark")`: Seedream 5.0 lite text-to-image, and image-to-image from local refs, one image
  or a [group](#groups-paramsimages) of consistent images. The bytes come back unchanged, so
  Seedance trusts a face in them ([Faces](#faces)).
- `("asset", "ark")`: registers one portrait into an AIGC asset group through the signed Ark asset
  OpenAPI, and returns an `AssetRecord` (see the [asset README](../asset/README.md)).

The video and asset handlers are `submit` + `poll`, so the runner journals the task or asset id
before it waits. A crash or Ctrl-C resumes by polling the same job, never by paying twice. The image
handler is one call: once the request is sent, it runs to the end, so a paid image is not lost to a
pause.

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
   | `ARK_API_KEY` | Video tasks and Seedream images (Bearer). Needed at submit and poll time. |
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
| `downloadTimeoutMs` | `number` | `300_000` | Timeout of one clip or image download. A 1080p or 30 s clip is large. |
| `priceOverrides` | `Record<string, number>` | `{}` | By model id, wins over the catalog: USD per 1M output tokens for a video model, USD per image for an image model. |
| `cnyPerUsd` | `number` | `7.1` | CNY per 1 USD, to report cn prices in USD. |

```ts
const app = createApp({
  pluginConfigs: { ark: { region: "intl", groupId: "group-20260929120000-abcde" } }
});
```

## Models

`input.model` must be one of these ids, for the configured region. Any other id fails:
`[ai] Unknown ark model "<id>".\n  Known: <list>.`

Prices are USD per 1M output tokens, "no video input / with video input". intl prices are the list
prices of the [official price page](https://docs.byteplus.com/en/docs/modelark/model-pricing),
checked 2026-09-30.

| Model | Region | Clip | Resolutions | Refs img / vid / aud | Seed | Draft | Ratio follows the image | 480p / 720p | 1080p |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `dreamina-seedance-2-0-260128` | intl | 4–15 s | 480p, 720p, 1080p | 9 / 3 / 3 | no | no | no | $7.0 / $4.3 | $7.7 / $4.7 |
| `dreamina-seedance-2-0-fast-260128` | intl | 4–15 s | 480p, 720p | 9 / 3 / 3 | no | no | no | $5.6 / $3.3 | — |
| `dreamina-seedance-2-0-mini-260615` | intl | 4–15 s | 480p, 720p | 9 / 3 / 3 | no | no | no | $3.5 / $2.1 | — |
| `dreamina-seedance-2-5-260628` | intl | 4–30 s | 480p, 720p, 1080p | 30 / 10 / 10 | yes | yes | yes | $10.7 / $6.4 | $11.7 / $7.0 |
| `doubao-seedance-2-0-260128` | cn | 4–15 s | 480p, 720p, 1080p | 9 / 3 / 3 | no | no | no | ¥46 / ¥28 | same |
| `doubao-seedance-2-5-260628` | cn | 4–30 s | 480p, 720p, 1080p | 30 / 10 / 10 | yes | yes | yes | ¥70 / ¥42 | same, verify |

- `seconds` defaults to 5, `resolution` to `720p` (a draft to `480p`, a final to `1080p`).
- Every row can generate audio (`audio: true` → `generate_audio`).
- The cn rows come from summaries of the rate card. Check them in the console before a paid run.
- Enterprise accounts may get time-limited discounts (mini −60 %, fast −25 %, until 2026-10-07).
  They are not in the catalog. Set them with `priceOverrides`.
- Each row in `models.ts` carries its `// source:`.

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
| `aspect` | `ratio`: `16:9`, `9:16` (default), `1:1`, `4:3`, `3:4`, `21:9` or `adaptive`. Not sent when the model's ratio follows the image, see below |
| `resolution` | `resolution`, one of the model's |
| `audio` | `generate_audio` |
| `negative` | Not supported by Ark. Dropped, with one `ark:negative:ignored` warning per process |
| `fromDraft` | A final from this draft clip. See [Draft → final](#draft--final) |

A local image goes out as `data:<mime>;base64,...`. A `$ref` to an `asset` item goes out as
`asset://<assetId>`. Image refs and asset refs count together against the model's image limit. The
prompt cites refs by position ("image 1"); the handler never rewrites it.

**The ratio follows the image on Seedance 2.5.** With a first or last frame, 2.5 takes its output
ratio from the image and refuses `ratio` (`400 InvalidParameter.TaskTypeConstraint`). So the body
has no `ratio` then. An explicit `aspect` is still checked, but it cannot be honoured: one
`ark:ratio:ignored` warning per process. With reference images only, `ratio` is sent as usual.

### Params

`params` is an allowlist. Any other key fails:
`[ai] Unknown ark param "<key>".\n  Allowed: refUrls, watermark, seed, return_last_frame, execution_expires_after, priority, draft, generation.`

| Param | Meaning |
| --- | --- |
| `refUrls` | Video and audio references, as public https URLs. See below. |
| `watermark` | Passed through. Default `false`. |
| `seed` | Passed through only on a model that takes a seed (Seedance 2.5). Fails on the others. |
| `return_last_frame` | Passed through. The last frame URL comes back in `meta.lastFrameUrl`. |
| `execution_expires_after` | Passed through. |
| `priority` | Passed through. |
| `draft` | `true` only: a 480p draft. See [Draft → final](#draft--final). |
| `generation` | Never sent. It only changes the item key, so a new value renders again. |

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
    Use a Seedream image made by provider ark on this account, bytes unchanged, or an asset item.
  ```

- Otherwise: `[ai] ark flagged the request: <code>.\n  Change the prompt or the inputs.`

**There is no raw-photo fallback, and no registration after a refusal.** See [Faces](#faces) for the
two routes that work. A refused task is not billed.

### Poll and cost

| Task status | Result |
| --- | --- |
| `queued`, `running` | pending |
| `succeeded` | Download `content.video_url` at once (it expires 24 h after success). Done, `video/mp4`. |
| `failed` with a `SensitiveContent` code | failed, flagged |
| `failed`, other code | failed, terminal (400) with Ark's code and message |
| `expired`, `cancelled` | failed, terminal (410) |

Cost = `usage.completion_tokens / 1e6 × price`. The price is the "with video input" one when
`refUrls` holds a video URL, the base one otherwise. At 1080p a row's 1080p price is used when it has
one. `priceOverrides[model]` (USD) wins. cn prices are divided by `cnyPerUsd`.

The estimate is `width × height × (24 × seconds + 1) / 1024` tokens, rounded down, at the base
price. Sizes: 480p 864×496, 720p 1280×720, 1080p 1920×1080. 9:16 has the same area; other ratios use
the same area too. This matched the live bills exactly: 480p 5 s = 50,638 tokens ($0.3545 on
`dreamina-seedance-2-0-260128`), 1080p 5 s = 245,025 tokens. A draft is estimated at 480p, a final at
1080p for `seconds` (5 when absent).

`meta` is `{ taskId, model, seconds, resolution, completionTokens, seed?, draft?, draftTaskId?, lastFrameUrl? }`.
`seed` is the seed ark used. `draft: true` marks a draft, `draftTaskId` a final.

The clip is downloaded with `downloadTimeoutMs`, not `timeoutMs`. When ark sends no
`completion_tokens`, the cost is estimated from the task's seconds and resolution, and
`ark:cost:estimated` is logged. An unlisted resolution uses the nearest listed one: the task is
already paid, so this never throws.

## Faces

Seedance refuses a real face in an image from outside, for example a Codex keyframe. Two routes
work.

1. **Seedream first (trusted route).** Make the keyframe with an `image` item on provider ark. Then
   `$ref` it as `image` of the video item. BytePlus trusts the face when all of this holds:
   - the image was made by Seedream 5.0 lite text-to-image on the same account;
   - the bytes are unchanged: no crop, resize or re-encode (the image handler never touches them);
   - it is used within 30 days of being made ([portrait guide](https://docs.byteplus.com/en/docs/modelark/seedance-portrait-asset-guide)).
2. **Asset (second route).** Register the portrait in an `asset` item, and `$ref` it. See
   [Asset handler](#asset-handler).

## Draft → final

Seedance 2.5 makes a cheap 480p draft (`params.draft: true`). A final renders the same draft again
at 1080p: same frames, motion, seed and audio. Only the draft task goes to ark.

```yaml
items:
  - id: e01.s04.key
    task: image
    provider: ark
    input: { prompt: "Vertical 9:16 photo. Close-up, Akari ...", aspect: "9:16" }
  - id: e01.s04.draft
    task: video
    provider: ark
    input:
      model: dreamina-seedance-2-5-260628
      prompt: "Akari lifts the lid of a cake box ..."
      image: { $ref: e01.s04.key }
      seconds: 5
      audio: true
    params: { draft: true }
  - id: e01.s04.final
    task: video
    provider: ark
    input:
      model: dreamina-seedance-2-5-260628
      fromDraft: { $ref: e01.s04.draft }
```

**Draft.** `params.draft: true` on a model with a draft mode. The resolution is 480p: leave it out or
set `480p`. Errors, before any call:

```
[ai] Model <id> has no draft mode.
  Use dreamina-seedance-2-5-260628 for drafts.
[ai] ark drafts are 480p only.
  Remove input.resolution or set it to 480p.
```

When the draft task succeeds, ark keeps its task id in the journal (`provider_records`, kind
`draft`). The key is the sha256 of the clip, the same hash the store gives the artifact. So a
`$ref` to the draft item finds it. The record is scoped to this region and API key.

**Final.** `fromDraft: { $ref: <draft item> }` and the same `model`. `prompt` may be left out. The
final never reads `prompt`, `seconds`, `aspect`, `audio` or `negative`. The body is:

```json
{ "model": "dreamina-seedance-2-5-260628", "content": [{ "type": "draft_task", "draft_task": { "id": "<draft task id>" } }], "resolution": "1080p", "watermark": false }
```

Only `watermark`, `return_last_frame`, `execution_expires_after` and `priority` pass through. Every
check runs before any call. Each failure is a plain error: terminal, nothing billed.

| Check | Error |
| --- | --- |
| `fromDraft` is a video | `[ai] ark input.fromDraft must be the draft's video.\n  Point $ref at the draft item.` |
| No `image`, `endImage`, `refs`, `params.refUrls`, `params.seed`, `params.draft` | `[ai] ark final renders take only the draft.\n  Remove input.image.` (names the field) |
| Resolution absent or 1080p | `[ai] ark finals from a draft are 1080p only.\n  Remove input.resolution or set it to 1080p.` |
| The journal is open | `[ai] ark needs the journal to find a draft.\n  Call app.start() first.` |
| A draft record exists | `[ai] ark has no draft task for input.fromDraft.\n  Make the draft with provider ark and params.draft: true, in this project.` |
| Same model as the draft | `[ai] Draft <taskId> was made with <model>.\n  Set input.model to <model>.` |
| Draft younger than 7 days | `[ai] ark draft <taskId> expired on <ISO date>.\n  Bump params.generation on the draft item to render it again.` |

**The 7-day rule.** Ark keeps a draft id valid for 7 days from the draft's `created_at`. After that,
bump `params.generation` on the draft item: the draft renders again, and so does the final.

From code, pass the draft clip with its sha256 as `hash`, and `prompt: ""`:

```ts
const final = await app.video.generate(
  { model: "dreamina-seedance-2-5-260628", prompt: "", fromDraft: { path: "draft.mp4", mimeType: "video/mp4", hash: draftSha256 } },
  { provider: "ark" }
);
// => { video, mimeType: "video/mp4", costUsd: 2.866793, meta: { resolution: "1080p", draftTaskId, ... } }
```

Before `app.start()` the journal is closed: a draft is still returned, but its record is skipped with
one `ark:journal:closed` warning, and a final fails.

## Images (Seedream)

`image` items on provider ark. `POST {dataPlane}/images/generations` with the API key, then one
download of the image URL, without the key, with `downloadTimeoutMs`.

| Model | Region | Smallest size | Refs | Group: refs + images | Price |
| --- | --- | --- | --- | --- | --- |
| `seedream-5-0-lite-260128` (default) | intl | 3,686,400 px | 14 | 15 | $0.035 per image, with or without refs |

There is no cn image model yet. `input.model` defaults to the table's model. Any other id fails:
`[ai] Unknown ark image model "<id>".\n  Known: <list>.`

| `ImageRequest` | Seedream body |
| --- | --- |
| `prompt` | `prompt`, sent as written |
| `aspect` | `size`: `9:16` → `1440x2560` (default), `16:9` → `2560x1440`, `1:1` → `2048x2048`, `3:4` → `1728x2304`, `4:3` → `2304x1728`. Another aspect fails |
| `refs` | `image`: one ref as a string, several as an array, in request order. Absent without refs, so the text-to-image body is unchanged |
| `params.images` | `sequential_image_generation: "auto"` and `sequential_image_generation_options: { max_images }`. Absent without `params.images`, so the one-image body is unchanged |
| `negative` | Dropped, with one `ark:negative:ignored` warning per process |
| — | `response_format: "url"`, `watermark: false` |

**Refs (image-to-image).** Each local ref goes out as `data:<mime>;base64,...`, the format in
lowercase. Nothing is hosted. The prompt cites refs by position ("image 1"). Without `params.images`,
Seedream makes one image: `sequential_image_generation` is left at its default, `disabled`. Ark limits each ref to jpeg, png,
webp, bmp, tiff, gif, heic or heif, up to 30 MB and 6000×6000 px. More refs than the model takes
fail before any call, also at estimate time:

```
[ai] ark image model "seedream-5-0-lite-260128" takes at most 14 reference images, got 15.
  Remove refs from input.refs.
```

```yaml
- id: face-akari
  task: image
  provider: ark
  input: { prompt: "Photo of the woman in image 1, soft window light", aspect: "3:4",
           refs: [{ $file: refs/akari-lines.png }] }
```

`params` allowlist: `size`, `seed`, `generation`, `watermark`, `images`. `size` is `"<width>x<height>"` and
wins over the aspect. A size under the minimum fails before the call:

```
[ai] ark image size 1152x2048 is below 3686400 pixels.
  Use at least 1440x2560 for 9:16.
```

The result is the downloaded bytes, **unchanged**: never decoded, resized, cropped or re-encoded.
`mimeType` is the download's `Content-Type`, else it is read from the first bytes. `costUsd` is the
price per image times `usage.generated_images`. `meta` is `{ model, size }`. Estimate needs no key.

### Groups (`params.images`)

`params.images: N` asks Seedream for a group: up to N consistent images from one call (a storyboard,
the same character in several shots). The body gains `sequential_image_generation: "auto"` and
`sequential_image_generation_options: { max_images: N }`. Without `params.images` the body, the
artifact key and the result are exactly the one-image ones.

```yaml
- id: akari.panels
  task: image
  provider: ark
  input: { prompt: "Four panels of Akari baking, same apron, same kitchen", aspect: "9:16" }
  params: { images: 4 }
```

**Limits.** N is a whole number from 1 to 15, and refs plus N is at most 15 (`maxGroupImages`). Both
fail before any call, also at estimate time:

```
[ai] ark params.images must be a whole number from 1 to 15.
  Pass it like 6.

[ai] ark image model "seedream-5-0-lite-260128" makes at most 15 images including refs, got 14 refs + 2 images.
  Set params.images to 1 or less, or remove refs.
```

**Result.** Every `data[]` entry with a `url` is downloaded once, in order, unchanged. An entry
without a `url` (an `error` entry) is skipped; it does not fail the call. No `url` at all is an
unreadable response (retryable 502). `image` / `mimeType` are the first image, `images` lists every
image in order, and `meta` is `{ model, size, imagesRequested: N, imagesReturned: M }`. The runner
stores every image and exports `<label>.jpg`, `<label>-2.jpg` … `<label>-M.jpg`. A `$ref` to the item
is the first image.

**Short groups.** N is a cap: the model may return fewer. M < N is a result, not an error: it logs
`ark:image:group-short` (`{ model, requested: N, returned: M }`).

**Cost.** BytePlus bills each image it made; failed images are not charged. `costUsd` is the price
per image times `usage.generated_images`, else times M. The estimate prices N images: an upper
bound for the budget gate. `ark:image:done` carries `images: M` and the total bytes.

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
| A draft on a model without drafts, or not at 480p; `params.draft` other than `true` | Plain two-line error before any call (see [Draft → final](#draft--final)) |
| A final that breaks a rule: not a video, extra inputs, not 1080p, journal closed, no draft, other model, expired | Plain two-line error before any call (see [Draft → final](#draft--final)) |
| Seedream: unknown image model, refs, bad `params.images` or refs plus images over 15, unknown param, unknown aspect, size under the minimum | Plain two-line error before any call |
| Seedream error body without an `error` wrapper (`{ code, message }`) | Read like a wrapped one: terminal with ark's code and message |

Messages start with `[ai]` and never contain a key or a signed URL. Logs carry
ids, codes, sizes and statuses only: `ark:video:submitted`, `ark:video:done`, `ark:video:failed`,
`ark:draft:recorded`, `ark:journal:closed`, `ark:ratio:ignored`, `ark:cost:estimated`,
`ark:image:done`, `ark:image:group-short`, `ark:asset:group-created`, `ark:asset:registered`,
`ark:asset:refused`, `ark:negative:ignored`.

## API

```ts
app.ark.info();
// => { provider: "ark", region: "intl", configured: { video: true, assets: false, image: true },
//      models: ["dreamina-seedance-2-0-260128", "dreamina-seedance-2-0-fast-260128",
//               "dreamina-seedance-2-0-mini-260615", "dreamina-seedance-2-5-260628"],
//      imageModels: ["seedream-5-0-lite-260128"] }
```

No network call. `configured.video` and `configured.image` are true when the API key is set,
`configured.assets` when both the access key and the secret key are set. `models` and `imageModels`
list the configured region's ids.

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
body from a public issue. Bodies captured on a live BytePlus intl run (a 2.5 draft and its final, the
ratio and face refusals, a Seedream response and its size error) carry
`// source: live BytePlus intl 2026-09-30`, with the URLs redacted. A field no source confirms carries
an `// unverified:` note. Built request bodies are compared with `toEqual` against those examples, so
drift from the docs fails a test. The integration tests run the full framework on mocked fetch: one
asset item and two clips, reuse on a second run, a refused asset that blocks both clips, both
facades; and the image → draft → final build file above, its reuse on a second run, and a final
added after 7 days that fails with no call.
