# fal

> Video provider over the fal queue REST API (submit, status, result). Complex tier. Registers `("video", "fal")` with the registry in `onInit`.

## Purpose

A video job takes 2 to 10 minutes. The handler implements the async `video` contract, `submit` + `poll`,
so the runner journals the fal request id before it waits. A crash, Ctrl-C or a timeout of the caller is
continued by polling the same job; it is never submitted and paid twice. There is no `execute`: the
one-off `app.video.generate()` facade runs the same `submit` + `poll` loop with `video.pollIntervalMs`.

Prices are data in `prices.ts`, USD per second. A model without a price throws from `estimate`, so
`moku estimate` and `--max-cost` never count it as $0 (D13).

## Configuration

Set via `createApp({ pluginConfigs: { fal: { ... } } })`.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKeyEnv` | `string` | `"FAL_KEY"` | Env var with the key, read through `ctx.env` at submit/poll time. Estimates never need it. |
| `queueUrl` | `string` | `"https://queue.fal.run"` | Queue base URL. Submit is `POST <queueUrl>/<endpoint>`. |
| `uploadUrl` | `string` | `"https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3"` | Storage upload initiate URL. |
| `upload` | `"storage" \| "data-uri"` | `"storage"` | How local keyframes reach fal. `storage` falls back to a data URI when the upload fails. |
| `timeoutMs` | `number` | `60_000` | Timeout of one HTTP request (submit, status, result, download). |
| `priceOverrides` | `Record<string, number>` | `{}` | USD per second, keyed `<alias>`, `<alias>@<resolution>` or `<alias>+audio`. |

## Models

`input.model` must be one of these aliases. Any other value throws `Unknown fal video model`.

| Alias | fal endpoint | Keyframe field | Image refs | Audio refs | Duration | Audio |
| --- | --- | --- | --- | --- | --- | --- |
| `seedance-2.5` | `bytedance/seedance-2.5/image-to-video` | `image_url` | none | none | `"4"`..`"30"` | `generate_audio` |
| `seedance-2.5-ref` | `bytedance/seedance-2.5/reference-to-video` | `image_urls[0]` (`@Image1` in the prompt) | rest of `image_urls` (max 29) | `audio_urls` (max 10) | `"4"`..`"30"` | `generate_audio` |
| `minimax-h3` | `minimax/h3/image-to-video` | `image_url` | none | none | integer | always on (native stereo) |
| `minimax-h3-max-ref` | `minimax/h3-max/reference-to-video` | `reference_image_urls[0]` (`Image 1` in the prompt) | rest of `reference_image_urls` (max 8) | `reference_audio_urls` (max 3) | integer 5-15 | always on (native stereo) |
| `kling-3-pro` | `fal-ai/kling-video/v3/pro/image-to-video` | `start_image_url` | none | none | `"3"`..`"15"` | `generate_audio` |
| `kling-o3-ref` | `fal-ai/kling-video/o3/pro/reference-to-video` | `start_image_url` | `image_urls` (max 4) | none | `"3"`..`"15"` | `generate_audio` |
| `seedance-2.0-mini` | `bytedance/seedance-2.0/mini/image-to-video` | `image_url` | none | none | string, e.g. `"5"` | `generate_audio` |
| `seedance-2.0-mini-ref` | `bytedance/seedance-2.0/mini/reference-to-video` | `image_urls[0]` | rest of `image_urls` (max 8) | `audio_urls` (max 3) | string, e.g. `"5"` | `generate_audio` |
| `seedance-2.0-ref` | `bytedance/seedance-2.0/reference-to-video` | `image_urls[0]` | rest of `image_urls` (max 8) | `audio_urls` (max 3) | string, e.g. `"5"` | `generate_audio` |
| `wan-3.0-ref` | `alibaba/wan-3.0/reference-to-video` | `reference_image_urls[0]` | rest of `reference_image_urls` (max 9) | `reference_audio_urls` (max 5) | integer | `audio` |
| `veo-3.1-fast` | `fal-ai/veo3.1/fast/image-to-video` | `image_url` | none | none | `"4s"` / `"6s"` / `"8s"` | `generate_audio` |
| `vidu-q3` | `fal-ai/vidu/q3/image-to-video` | `image_url` | none | none | integer | `audio` |
| `vidu-q3-ref` | `fal-ai/vidu/q3/reference-to-video/mix` | `reference_image_urls[0]` | rest of `reference_image_urls` (max 3) | none | integer | `audio` |

Request fields map as: `prompt`, `image` (required), `refs`, `seconds` (default 5), `aspect` (default `9:16`,
sent where the model takes `aspect_ratio`; `vidu-q3` has none, its clip takes the image's aspect),
`resolution` (default `720p` Seedance, Wan, Veo and Vidu, `768P` MiniMax), `audio` (default off),
`negative` (only `kling-3-pro` and `veo-3.1-fast` have `negative_prompt`; the other fal schemas have no
negative field, so it is not sent). `request.params` is merged last into the body, so any model field can
be set from the build file.

**Refs.** A ref with an `audio/*` MIME type is an audio ref (a voice timbre anchor); every other ref is an
image ref. Too many image or audio refs for the model fail the item with a terminal error before any upload,
so a shot is never silently cut down:

```
[ai] fal model "kling-o3-ref" takes at most 4 reference images, got 6.
  Remove refs from input.refs, or use a model that takes more.
```

**MiniMax H3 dialogue.** H3 and H3 Max voice lines written in the prompt, e.g. `<d>[Japanese] 行こう。</d>`.
H3 Max sends `prompt_expansion_mode: "balanced"` (the schema requires it; override with `params`).

## Prices (USD per second)

| Key | USD/s |
| --- | --- |
| `seedance-2.5@480p`, `seedance-2.5-ref@480p` | 0.2205 |
| `seedance-2.5@720p`, `seedance-2.5-ref@720p` | 0.4730 |
| `minimax-h3@480P` / `@768P` / `@2K` / `@4K` | 0.05 / 0.06 / 0.13 / 0.16 |
| `minimax-h3-max-ref@480P` / `@768P` / `@1080P` | 0.05 / 0.08 / 0.16 |
| `kling-3-pro` / `kling-3-pro+audio` | 0.112 / 0.168 |
| `kling-o3-ref` / `kling-o3-ref+audio` | 0.112 / 0.14 |
| `seedance-2.0-mini@480p` / `@720p`, `seedance-2.0-mini-ref@480p` / `@720p` | 0.0721 / 0.1547 |
| `seedance-2.0-ref@720p` / `@1080p` | 0.3034 / 0.682 |
| `wan-3.0-ref@480p` / `@720p` / `@1080p` | 0.05 / 0.10 / 0.20 |
| `veo-3.1-fast` / `veo-3.1-fast+audio` / `veo-3.1-fast@4k` | 0.10 / 0.15 / 0.35 |
| `vidu-q3@360p` / `@540p` / `@720p` / `@1080p` | 0.07 / 0.07 / 0.154 / 0.154 |
| `vidu-q3-ref@360p` / `@540p` / `@720p` / `@1080p` | 0.07 / 0.07 / 0.154 / 0.154 |

Lookup order: `<alias>@<resolution>`, then `<alias>+audio` when audio is on, then `<alias>`.
`veo-3.1-fast` has a resolution row only for `4k`. At `720p` it takes `veo-3.1-fast+audio` with audio on,
`veo-3.1-fast` with audio off.
Cost = seconds × USD/s + reference-token surcharge. `estimate` and the recorded cost use the same function.

**Reference tokens (`minimax-h3-max-ref`).** Keys `minimax-h3-max-ref#refTokensIncluded` (4096) and
`minimax-h3-max-ref#refTokenUsdPer1k` (0.02). Surcharge = max(0, tokens − 4096) × 0.02 / 1000. Tokens:

| Input | Tokens |
| --- | --- |
| Image (first frame and each image ref), by aspect ratio from its PNG/JPEG/WebP header | 1:1 1024, 4:3 1376, 16:9 1824, 5:2 2560 (a ratio in between takes the next row up) |
| Image not resolved yet, or unreadable | 2560 |
| Any audio refs | 1200 in total (fal's 15 s maximum at ~80 tokens/s) |

Example: 5 s at 768P with four square images is 0.40; with five it is 0.42048. The estimate can only be
higher than fal's bill, never lower.

Seedance 2.5 and 2.0 Mini 1080p have no bundled price. Add `seedance-2.5@1080p` (or
`seedance-2.0-mini@1080p`) to `priceOverrides` to use it.

## Job protocol

1. **Upload.** `storage`: `POST uploadUrl { file_name, content_type }` → `{ upload_url, file_url }`, then
   `PUT upload_url` with the bytes. On any failure, a `data:<mime>;base64,...` URI for this and later files.
2. **Submit.** `POST <queueUrl>/<endpoint>` with `Authorization: Key <FAL_KEY>`. The job id is JSON
   `{ endpoint, requestId, statusUrl, responseUrl }`; status and result URLs are used as fal returned them.
3. **Poll.** `GET statusUrl`: `IN_QUEUE` / `IN_PROGRESS` → pending. `COMPLETED` with `error` →
   `{ state: "failed", error }`. `COMPLETED` → `GET responseUrl`, download `video.url` →
   `{ state: "done", video, mimeType, costUsd, meta: { endpoint, requestId, seconds } }`.

## Errors

| Condition | Result |
| --- | --- |
| Caller abort | Rethrown unchanged (clean pause). It stops uploads; a queue POST already sent runs to the end, so a billed job always returns its id |
| Request timeout / network failure | Retryable, `kind: "timeout"` / `"network"` (a poll keeps polling) |
| 429 | Retryable, `status: 429`, `Retry-After` honored |
| 5xx | Retryable, `status` |
| 422 `content_policy_violation`, `error_type` with `content_policy`, or fal's text matching `sensitive` / `likeness` / `nsfw` / `moderation` (any case) | Flagged, never re-queued |
| Other 4xx | Terminal, `status` |
| Result or download of a `COMPLETED` job answers 400 or 422 | `failed`, terminal: fal's verdict on the job, never polled again |
| Result or download of a `COMPLETED` job fails with another 4xx | Retryable 503 (`fal:result:unreadable`): the clip exists and is paid for, so polling goes on and the job stays adoptable |
| Job `COMPLETED` + `generation_timeout` / `downstream_service_unavailable` / `internal_server_error` | `failed` with a retryable 503: the next attempt submits again |
| Job `COMPLETED` + other error | `failed`, terminal 400 |
| `FAL_KEY` not set, unknown model, missing image, too many refs | Plain error: terminal after one attempt, nothing billed |

Messages start with `[ai] fal …` and never contain the key. Logs carry ids and statuses, never prompts.

## API

```ts
app.fal.info(); // => { provider: "fal", configured: true, models: ["seedance-2.5", ...] }
```

`configured` is true when `FAL_KEY` (or the configured variable) is set.

## Usage

```yaml
items:
  - id: s01.key
    task: image
    provider: codex
    input: { prompt: "patisserie counter at night", aspect: "9:16" }
  - id: s01.kling
    task: video
    provider: fal
    input:
      model: kling-3-pro
      prompt: "slow push-in, she smiles"
      image: { $ref: s01.key }
      seconds: 5
      audio: true
```

```ts
app.video.estimate({ model: "minimax-h3", prompt: "push-in", seconds: 5 }, { provider: "fal" }); // { usd: 0.3 }
```
