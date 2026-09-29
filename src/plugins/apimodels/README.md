# apimodels

> Video provider over the apimodels.app task API (submit, poll, records). Complex tier. Registers `("video", "apimodels")` with the registry in `onInit`.

## Purpose

apimodels serves Seedance 2.5 and Seedance 2.0 official, and these accept real-person photos. fal's Seedance
endpoints refuse a real face and have no asset field. apimodels takes a face in two ways: it registers a
refused photo by itself and retries (the auto path), or the request names the inputs this plugin registers
first and sends as `asset://` ids (`params.assets`).

The handler implements the async `video` contract, `submit` + `poll`, like fal. The job id is JSON
`{ taskId, model, assetUsd }`, journaled by the runner before it waits. A crash, Ctrl-C or restart polls the
same task again; it is not submitted and paid twice. There is no `execute`: `app.video.generate()` drives the
same `submit` + `poll` loop.

## Configuration

Set via `createApp({ pluginConfigs: { apimodels: { ... } } })`.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKeyEnv` | `string` | `"APIMODELS_API_KEY"` | Env var with the key, read through `ctx.env` at submit and poll time. Estimates never need it. |
| `baseUrl` | `string` | `"https://api.apimodels.app/v1"` | API base URL, no trailing slash (100 MB bodies). |
| `assetGroup` | `string` | `"moku-ai"` | Name of the asset group, created once per account on the first registration. |
| `timeoutMs` | `number` | `60_000` | Timeout of one HTTP request. Also caps the local `Retry-After` wait of uploads and registrations. |
| `priceOverrides` | `Record<string, number>` | `{}` | Replaces bundled prices per key: `<alias>@<resolution>` (USD/s) or `asset` (USD per registration). |

## Models

`input.model` must be one of these aliases. They mirror fal's Seedance aliases, so a build item switches
`provider` only. Any other value fails with a terminal 400.

| Alias | API `model` | `image` → | `endImage` → | `refs` → | Resolutions | Seconds | USD/s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `seedance-2.5` | `seedance-2.5` | `first_frame_url` | `last_frame_url` | refused | 480p, 720p | 4-30 | 0.12 / 0.27 |
| `seedance-2.5-ref` | `seedance-2.5` | `reference_image_urls[0]` (`@image1`) | refused | images → `reference_image_urls` (30 with the image), audio → `reference_audio_urls` (10), video → `reference_video_urls` (10) | 480p, 720p | 4-30 | 0.12 / 0.27 |
| `seedance-2.0` | `seedance-2.0-official` | `first_frame_url` | `last_frame_url` | refused | 480p, 720p, 1080p | 4-15 | 0.092 / 0.197 / 0.492 |
| `seedance-2.0-ref` | `seedance-2.0-official` | `reference_image_urls[0]` | refused | as 2.5-ref, images 9 with the image | 480p, 720p, 1080p | 4-15 | 0.092 / 0.197 / 0.492 |

Body: `{ model, prompt, resolution, duration: seconds, aspect_ratio: aspect, generate_audio: audio, <input fields> }`.
Defaults: `seconds` 5, `aspect` `"9:16"`, `audio` true, `resolution` 720p. `aspect_ratio` is not sent with
`first_frame_url` (upstream forces adaptive). `negative` is not supported upstream: it is dropped and logged
at debug level (`apimodels:negative:ignored`, without the text). `request.params` is merged last, after the
reserved key `assets` is removed.

Refs are told apart by MIME type (`image/*`, `audio/*`, `video/*`). Every alias needs `image`. A refused field,
a resolution or clip length outside the table, or too many refs fails with a terminal 400 at estimate and at
submit, before any upload or charge:

```
[ai] apimodels model "seedance-2.5-ref" takes no end frame.
  Remove input.endImage, or use a model that takes one: seedance-2.5, seedance-2.0.
[ai] apimodels model "seedance-2.0-ref" takes at most 9 reference images (input.image included), got 10.
  Remove refs from input.refs, or use a model that takes more.
```

At estimate time a `$ref` / `$file` ref has no MIME type yet: it counts only against the total
(images + audio + video), never as an image. Submit checks each group exactly.

## Assets (`params.assets`)

`params.assets` lists the inputs to send as `asset://` ids: `"image"`, `"endImage"` or `"refs.<n>"` (the n-th
entry of `input.refs`). Without it, every input goes as an https upload and apimodels registers a refused face
by itself. Name only portraits: props, locations and sketch sheets never need to be in a third-party identity store.

```yaml
- task: video
  id: shot-03
  provider: apimodels
  input:
    model: seedance-2.5
    prompt: "She turns to the window, slow push-in."
    image: { $file: cast/anna.png }
    seconds: 8
  params: { assets: ["image"] }
```

`params` sits next to `input`, not inside it: the runner hands the handler `{ ...input, params }`.

- **Validation.** A list of valid names, each naming an input the request has, each once (estimate and submit).
  A named input must be `image/*` (submit only, where inputs are resolved). Anything else is a terminal 400.
- **Lookup per named input.** `state.assets` (this process) → journal provider record → register. Register is
  upload (`POST /files`) → group id (`state.groups` → journal record `asset-group` → `POST /assets/groups`) →
  `POST /assets`. New ids go to both tiers; the journal gets one `putProviderRecords` call per submit, also when
  a later registration of the same submit failed.
- **Keys.** Every cache key uses the `VideoFile.hash` the runner delivered (the sha256 of a `$file`, the store
  hash of a `$ref`), never recomputed. The account is `sha256("moku-ai:" + apiKey)`, first 12 hex characters:
  a non-reversible fingerprint, not the key. A key change never reuses another account's ids.
- **Journal not open.** `app.video.generate()` before `app.start()` uses the state tier only and logs
  `apimodels:journal:closed` once per process.
- **Cost.** A registration costs `asset` (0.01). Each one logs `apimodels:asset:registered { account, usd }`, so a
  submit that fails later still leaves an audit line. The submit's registrations ride in the job id and are added
  to the done cost. The estimate adds 0.01 per named input: a worst case, it cannot see the cache.
- **In flight.** Concurrent submits share one pending call: the group per account, the registration per account
  and face, the upload per file. The entry is dropped when the call settles; only the submit that made a call pays for it.
- **Stale group.** A 4xx on `POST /assets` whose text names the group drops the group id from both tiers, resolves
  the group again (created once) and registers once more. A second failure is thrown as is.
- **Moderation.** A 422 on `POST /assets` (moderation, or a URL apimodels cannot fetch; not charged) is flagged
  before any clip is paid. 402 is terminal. 429 and 5xx are retryable.
- **Stale ids.** A submit or poll that fails with `INVALID_INPUT` naming an asset drops every asset record the
  request used, from both tiers. `submit` throws a retryable 503, `poll` returns `failed` with a retryable 503, so
  the next attempt registers again. The second stale answer for the same item (account, model, prompt, seconds and
  inputs) in one process is a terminal 400. Two items that share a face each get their own retry.
- **Slots.** Uploads and registrations of one submit run 4 at a time. A 429 among them waits `Retry-After` once
  (capped at `timeoutMs`, 1 s without the header), then is thrown.

## Job protocol

1. **Submit.** Validate, read the key, upload the plain inputs (cached per `file:<mime>:<hash>`), resolve the
   named ones, then `POST /video/generations` with `Authorization: Bearer <key>`. An abort stops the uploads;
   once the POST is sent it runs to the end, so a billed task always returns its id.
2. **Poll.** `GET /video/generations?task_id=<id>`. `data.state` is the truth, never the HTTP status alone.
3. **Done.** Download `resultUrls[0]` without the key (the result host is not apimodels). The MIME type is the
   download's `video/*` content type, else `video/mp4`. `GET /records/<taskId>`: when `settled` is true,
   `currency` is `"USD"` and `credits` a number, the cost is `credits + assetUsd`; otherwise, or on any error of
   that call, the table price `+ assetUsd`. The records call never fails the poll.

| Upstream | Poll returns |
| --- | --- |
| `pending`, `processing`, or an unknown state | `pending` |
| `completed`, clip downloads | `done` with `video`, `mimeType`, `costUsd`, `meta: { taskId, model, seconds }` |
| `completed`, download 403/404/410, or poll 404 (task unknown) | `failed`, retryable 503: the runner submits anew |
| `failed`, `CONTENT_MODERATION` | `failed`, flagged |
| `failed`, `INVALID_INPUT` naming an asset | records dropped, `failed` retryable 503; the second time terminal 400 |
| `failed`, `retryable: true`, or `UPSTREAM_BUSY` / `UPSTREAM_FAILED` / `TIMEOUT` / `INTERNAL_ERROR` / `OTHER` | `failed`, retryable 503 |
| `failed`, anything else | `failed`, terminal 400 |
| HTTP 429 / 5xx / timeout / network on the poll | thrown retryable: the runner keeps the job pending |
| Key missing at poll time, or HTTP 401/403 on the poll | thrown plain error, no status: the runner marks the job expired; fix the key and the next run adopts the same task |

`data.retryable` wins over the failCode when present.

**The 7-day window.** `resultUrls[0]` lives 7 days. A task adopted after that (a long pause, a resume weeks
later) finds its result gone: the poll returns a retryable failure and the runner submits the task again. That
clip is paid again. A dead result counts as one failed attempt: an item with one attempt left (a resume at
`maxAttempts - 1`) fails instead of re-submitting; run it again to pay for a new clip.

## Errors

| Condition | Result |
| --- | --- |
| Key not set at submit | Terminal 401, before any network call |
| Unknown model, missing image, refused field, bad resolution or seconds, too many refs, bad `params.assets` | Terminal 400, before any upload |
| 401 / 403 at submit | Terminal: check `APIMODELS_API_KEY` |
| 402 | Terminal: balance too low |
| 422 on asset registration, or failCode `CONTENT_MODERATION` | Flagged, never re-queued |
| Other 4xx | Terminal |
| 429 | Retryable, `Retry-After` honoured |
| 5xx, unreadable JSON (502) | Retryable |
| Timeout / network failure | Retryable, `kind: "timeout"` / `"network"` |
| Caller abort | Rethrown unchanged (clean pause) |
| Envelope `code` other than 200 on an HTTP 200 | Read like that HTTP status |

Messages start with `[ai] apimodels` and never contain the key or the prompt: both are cut out of any text
apimodels sends back. Logs carry task ids, statuses and the account fingerprint, never prompts or keys.

## Lane default

Upstream rate limits are not documented. The framework ships the lane default `video/apimodels`:
`{ concurrency: 2, rpm: 20 }`, set in `src/index.ts` (`limits` is a core plugin, so an app cannot set it).
The lane is held for the whole attempt, polling included.

## API

```ts
app.apimodels.info();
// { provider: "apimodels", configured: true, models: ["seedance-2.5", "seedance-2.5-ref", "seedance-2.0", "seedance-2.0-ref"] }
```

`configured` is true when `APIMODELS_API_KEY` (or the configured variable) is set.

## Not verified live

Built without a paid smoke test (2026-09-29). Each point has a safe path:

| Unverified | How the code stays safe |
| --- | --- |
| Does the auto path bill 0.01 per generation? | The explicit path exists; the consumer picks per request |
| `asset://` in `last_frame_url` | Allowed by `params.assets`; a refusal surfaces as a terminal error with apimodels' text |
| `first_frame_url` and `reference_image_urls` in one call | Two aliases per version: plain refuses refs, `-ref` refuses `endImage` |
| Rate limits | Lane default `concurrency: 2, rpm: 20`; 429 honours `Retry-After` |
| Asset expiry | Stale id: records dropped, registered once again, then a terminal failure |
| `group_id` / asset `id` types | Read as a string or a number, sent as text |
