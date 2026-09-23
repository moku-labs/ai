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

| Alias | fal endpoint | Keyframe field | Extra refs | Duration | Audio |
| --- | --- | --- | --- | --- | --- |
| `seedance-2.5` | `bytedance/seedance-2.5/image-to-video` | `image_url` | none | `"4"`..`"30"` | `generate_audio` |
| `seedance-2.5-ref` | `bytedance/seedance-2.5/reference-to-video` | `image_urls[0]` (`[Image1]` in the prompt) | rest of `image_urls` | `"4"`..`"30"` | `generate_audio` |
| `minimax-h3` | `minimax/h3/image-to-video` | `image_url` | none | integer | none (silent) |
| `kling-3-pro` | `fal-ai/kling-video/v3/pro/image-to-video` | `start_image_url` | none | `"3"`..`"15"` | `generate_audio` |
| `kling-o3-ref` | `fal-ai/kling-video/o3/pro/reference-to-video` | `start_image_url` | `image_urls` (max 4) | `"3"`..`"15"` | `generate_audio` |

Request fields map as: `prompt`, `image` (required), `refs`, `seconds` (default 5), `aspect` (default `9:16`,
sent where the model takes `aspect_ratio`), `resolution` (default `720p` Seedance, `768P` MiniMax),
`audio` (default off), `negative` (Kling v3 `negative_prompt` only). `request.params` is merged last into
the body, so any model field can be set from the build file.

## Prices (USD per second)

| Key | USD/s |
| --- | --- |
| `seedance-2.5@480p`, `seedance-2.5-ref@480p` | 0.2205 |
| `seedance-2.5@720p`, `seedance-2.5-ref@720p` | 0.4730 |
| `minimax-h3@480P` / `@768P` / `@2K` / `@4K` | 0.05 / 0.06 / 0.13 / 0.16 |
| `kling-3-pro` / `kling-3-pro+audio` | 0.112 / 0.168 |
| `kling-o3-ref` / `kling-o3-ref+audio` | 0.112 / 0.14 |

Lookup order: `<alias>@<resolution>`, then `<alias>+audio` when audio is on, then `<alias>`.
Cost = seconds × USD/s. `estimate` and the recorded cost use the same function.

Seedance 1080p has no bundled price. Add `seedance-2.5@1080p` to `priceOverrides` to use it.

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
| Caller abort | Rethrown unchanged (clean pause) |
| Request timeout / network failure | Retryable, `kind: "timeout"` / `"network"` (a poll keeps polling) |
| 429 | Retryable, `status: 429`, `Retry-After` honored |
| 5xx | Retryable, `status` |
| 422 `content_policy_violation`, or `error_type` with `content_policy` | Flagged, never re-queued |
| Other 4xx | Terminal, `status` |
| Job `COMPLETED` + `generation_timeout` / `downstream_service_unavailable` / `internal_server_error` | `failed` with a retryable 503: the next attempt submits again |
| Job `COMPLETED` + other error | `failed`, terminal 400 |
| `FAL_KEY` not set, unknown model, missing image | Plain error: terminal after one attempt, nothing billed |

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
