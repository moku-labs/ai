# fal

> Every fal-hosted task over one client, one key, one upload cache and one price table. Complex tier. Registers `("video", "fal")`, `("image", "fal")`, `("prompt-gen", "fal")` and `("music", "fal")` with the registry in `onInit`. Emits no events.

## Purpose

One plugin per vendor: the four fal tasks share `client/` (HTTP and error classification, the queue, the
upload), one `FAL_KEY`, one upload cache keyed by content sha256, one merged price table and one opt-in
request log.

- **video**: the async contract, `submit` + `poll`. A job takes 2 to 10 minutes; the runner journals the
  fal request id before it waits, so a crash, Ctrl-C or a timeout continues the same job and never pays twice.
- **image** and **music**: `estimate` + `execute` + `submit` + `poll` over the generic queue. The runner drives
  `submit` + `poll`; the one-off facades (`app.image.generate`, `app.music.generate`) call `execute`, which
  submits and waits in process every `pollMs`, at most `jobTimeoutMs`.
- **prompt-gen**: `estimate` + `execute`, one sync POST to fal's OpenRouter router.

Every handler validates and prices a request before it reads the key, uploads or POSTs: nothing is billed for a
bad request. A model without a price throws from `estimate`, so `moku estimate` and `--max-cost` never count it
as $0 (D13).

## Configuration

Set via `createApp({ pluginConfigs: { fal: { ... } } })`. Flat keys only (shallow merge).

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKeyEnv` | `string` | `"FAL_KEY"` | Env var with the key, read through `ctx.env` per request. Estimates and `models()` never need it. |
| `queueUrl` | `string` | `"https://queue.fal.run"` | Queue base URL. Submit is `POST <queueUrl>/<endpoint>` (video, image, music). |
| `uploadUrl` | `string` | `"https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3"` | Storage upload initiate URL. |
| `upload` | `"storage" \| "data-uri"` | `"storage"` | How local files (frames, refs, prompt-gen images) reach fal. `storage` falls back to a data URI when the upload fails. |
| `timeoutMs` | `number` | `60_000` | Timeout of one HTTP request (submit, status, result, download, chat POST). |
| `priceOverrides` | `Record<string, number>` | `{}` | One table for every task; keys in [Prices](#prices). |
| `runUrl` | `string` | `"https://fal.run"` | Sync endpoint base. prompt-gen POSTs `<runUrl>/openrouter/router/openai/v1/chat/completions`. |
| `imageDefaultModel` | `string` | `"gpt-image-2.5"` | Image model when `ImageRequest.model` is omitted. |
| `llmDefaultModel` | `string` | `"anthropic/claude-opus-5.5"` | prompt-gen model when `PromptGenRequest.model` is omitted or `"default"`. |
| `pollMs` | `number` | `2000` | Status-check cadence of the in-process wait of image and music `execute`. |
| `jobTimeoutMs` | `number` | `900_000` | The in-process wait gives up after this (retryable `timeout`); the job keeps running on fal. |
| `requestLog` | `string \| undefined` | `undefined` | JSONL request log path, relative to the working directory. Off when undefined. |

`MusicRequest.model` is required, so there is no music default: the runner hashes the input as written.

## Layout

```
index.ts types.ts state.ts api.ts log.ts prices.ts   prices.ts = merge + prefix only
client/  http.ts queue.ts upload.ts                  shared: fetch + errors, queue + wait, generic upload
video/   handler.ts job.ts models.ts prices.ts image-size.ts upload.ts
image/   handler.ts models.ts prices.ts
llm/     handler.ts chat.ts models.ts prices.ts tokens.ts
music/   handler.ts models.ts prices.ts
```

Each task directory owns its models and prices; a new model touches one directory.

## Video

### Video models

`input.model` must be one of these aliases. Any other value throws `Unknown fal video model`.

| Alias | fal endpoint | Keyframe field | End frame | Image refs | Audio refs | Video refs (`maxVideoRefs`) | Video refs length (`maxVideoRefSec`) | Duration | Audio |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `seedance-2.5` | `bytedance/seedance-2.5/image-to-video` | `image_url` | `end_image_url` | none | none | none | 0 | `"4"`..`"30"` | `generate_audio` |
| `seedance-2.5-ref` | `bytedance/seedance-2.5/reference-to-video` | `image_urls[0]` (`@Image1` in the prompt) | none | rest of `image_urls` (max 29) | `audio_urls` (max 10) | `video_urls` (max 10) | 30.2 s combined, 1.8-30.2 s each | `"4"`..`"30"` | `generate_audio` |
| `minimax-h3` | `minimax/h3/image-to-video` | `image_url` | `end_image_url` | none | none | none | 0 | integer | always on (native stereo) |
| `minimax-h3-max-ref` | `minimax/h3-max/reference-to-video` | `reference_image_urls[0]` (`Image 1` in the prompt) | none | rest of `reference_image_urls` (max 8) | `reference_audio_urls` (max 3) | `reference_video_urls` (max 3) | 15 s combined, 2-15 s each | integer 5-15 | always on (native stereo) |
| `minimax-h3-max-i2v` | `minimax/h3-max/image-to-video` | `image_url` | `end_image_url` | none | none | none | 0 | integer | always on (native stereo) |
| `minimax-h3-ref` | `minimax/h3/reference-to-video` | `reference_image_urls[0]` (`Image 1` in the prompt) | none | rest of `reference_image_urls` (max 8) | `reference_audio_urls` (max 3) | `reference_video_urls` (max 3) | 15 s combined, 2-15 s each | integer 5-15 | always on (native stereo) |
| `minimax-h3-max-extend` | `minimax/h3-max/extend-video` | `video_url` (the source clip, from `input.image`) | none | none | none | none | 0 | integer 5-15, new footage only | always on (native stereo) |
| `kling-3-pro` | `fal-ai/kling-video/v3/pro/image-to-video` | `start_image_url` | `end_image_url` | none | none | none | 0 | `"3"`..`"15"` | `generate_audio` |
| `kling-o3-ref` | `fal-ai/kling-video/o3/pro/reference-to-video` | `start_image_url` | none | `image_urls` (max 4) | none | none | 0 | `"3"`..`"15"` | `generate_audio` |
| `seedance-2.0-mini` | `bytedance/seedance-2.0/mini/image-to-video` | `image_url` | `end_image_url` | none | none | none | 0 | string, e.g. `"5"` | `generate_audio` |
| `seedance-2.0-mini-ref` | `bytedance/seedance-2.0/mini/reference-to-video` | `image_urls[0]` | none | rest of `image_urls` (max 8) | `audio_urls` (max 3) | `video_urls` (max 3) | 15 s combined | string, e.g. `"5"` | `generate_audio` |
| `seedance-2.0-ref` | `bytedance/seedance-2.0/reference-to-video` | `image_urls[0]` | none | rest of `image_urls` (max 8) | `audio_urls` (max 3) | `video_urls` (max 3) | 15 s combined | string, e.g. `"5"` | `generate_audio` |
| `wan-3.0-ref` | `alibaba/wan-3.0/reference-to-video` | `reference_image_urls[0]` | none | rest of `reference_image_urls` (max 9) | `reference_audio_urls` (max 5) | none | 0 | integer | `audio` |
| `veo-3.1-fast` | `fal-ai/veo3.1/fast/image-to-video` | `image_url` | none | none | none | none | 0 | `"4s"` / `"6s"` / `"8s"` | `generate_audio` |
| `vidu-q3` | `fal-ai/vidu/q3/image-to-video` | `image_url` | `end_image_url` | none | none | none | 0 | integer | `audio` |
| `vidu-q3-ref` | `fal-ai/vidu/q3/reference-to-video/mix` | `reference_image_urls[0]` | none | rest of `reference_image_urls` (max 3) | none | none | 0 | integer | `audio` |
| `gemini-omni-1.1-flash` | `google/gemini-omni-flash/v1.1/image-to-video` | `image_url` | `end_image_url` | none | none | none | 0 | integer 3-10 | no flag |
| `gemini-omni-1.1-flash-ref` | `google/gemini-omni-flash/v1.1/reference-to-video` | `image_urls[0]` (`<IMAGE_REF_0>` in the prompt) | none | rest of `image_urls` (max 9) | none | `reference_video_urls` (max 3) | 3 s each (9 s combined) | integer 3-10 | no flag |

Video-ref limits are from the fal model pages of 2026-09-25; `minimax-h3-ref` and the Gemini Omni rows
from the fal schemas of 2026-09-26. End frames and the `minimax-h3-max-i2v` row are from the fal schemas
of 2026-09-29. The Seedance 2.0 and 2.0 Mini values follow
Seedance 2.0's reference schema; check them against fal before a release.

Request fields map as: `prompt`, `image` (required), `endImage` (see below), `refs`, `seconds` (default 5), `aspect` (default `9:16`,
sent where the model takes `aspect_ratio`; `vidu-q3` has none, its clip takes the image's aspect),
`resolution` (default `720p` Seedance, Wan, Veo, Vidu and Gemini Omni, `768P` MiniMax; fal's own H3 default is 2K), `audio` (default off),
`negative` (only `kling-3-pro` and `veo-3.1-fast` have `negative_prompt`; the other fal schemas have no
negative field, so it is not sent). `request.params` is merged last into the body, so any model field can
be set from the build file.

**Refs.** A ref with an `audio/*` MIME type is an audio ref (a voice timbre anchor). A ref with a `video/*`
MIME type is a video ref, for example the tail of the previous take. Every other ref is an image ref. Too many
image, audio or video refs for the model fail the item with a terminal error before any upload, so a shot is
never silently cut down:

```
[ai] fal model "kling-o3-ref" takes at most 4 reference images, got 6.
  Remove refs from input.refs, or use a model that takes more.
[ai] fal model "kling-o3-ref" takes no video references, got 1.
  Remove refs from input.refs, or use a model that takes more.
```

**Asset refs.** fal cannot use registered assets. An `image`, `endImage` or ref that `$ref`s an `asset` item fails the item with a terminal HTTP 400 error before any upload. Use provider `ark` for those items.

**End frame.** `input.endImage` is the last frame: the clip ends on this image. Like `image`, it is a `$ref` or
`$file`. It goes out as `end_image_url` on the seven models with `end_image_url` in the End frame column; a body
gets the field only when the request has an end frame, so a request without one sends the same body as before.
Any other model fails the item with a terminal error before any upload:

```
[ai] fal model "veo-3.1-fast" takes no end frame.
  Remove input.endImage, or use a model that takes one: seedance-2.5, minimax-h3, minimax-h3-max-i2v, kling-3-pro, seedance-2.0-mini, vidu-q3, gemini-omni-1.1-flash.
```

```yaml
  - id: s01.clip
    task: video
    provider: fal
    input:
      model: minimax-h3-max-i2v
      prompt: "she opens the door"
      image: { $ref: s01.start }
      endImage: { $ref: s01.end }
```

**Video refs.** `minimax-h3-max-ref`, `minimax-h3-ref` and `gemini-omni-1.1-flash-ref` send them as `reference_video_urls`; the Seedance reference models send
them as `video_urls`. A body gets the field only when the request has video refs. The plugin does not read
clip lengths: `maxVideoRefSec` is data for the caller, which keeps the clips within it. The plugin does not
check fal's 12-file cap on H3 Max (first frame and every ref) either.

**MiniMax H3 dialogue.** H3 and H3 Max voice lines written in the prompt, e.g. `<d>[Japanese] 行こう。</d>`.
`minimax-h3-max-ref` and `minimax-h3-ref` send `prompt_expansion_mode: "balanced"` (H3 Max requires it; override with `params`).
`minimax-h3-max-i2v` sends `prompt_expansion_mode: "disabled"`, so a start + end frame clip follows the prompt as written.
`minimax-h3-ref` uses the H3 Max body builder: the two schemas take the same fields.

**MiniMax H3 Max extend.** `minimax-h3-max-extend` continues a clip. Put the source clip in `input.image`, for
example `{ $ref: s01.kling }`. It goes out as `video_url`: 1.625-60 s, up to 50 MB, aspect 0.4-2.5. The prompt says
what happens next, not what the source shows. The body sends `output: "continuation"`, so only the new footage comes
back, and `enable_prompt_expansion: false`. It sends no `aspect_ratio`: fal's `auto` keeps the source's aspect.
Any of these can be changed with `params`. The plugin does not check the source's length, size or MIME type.

### Video prices (USD per second)

| Key | USD/s |
| --- | --- |
| `seedance-2.5@480p`, `seedance-2.5-ref@480p` | 0.2205 |
| `seedance-2.5@720p`, `seedance-2.5-ref@720p` | 0.4730 |
| `minimax-h3@480P` / `@768P` / `@2K` / `@4K` | 0.05 / 0.06 / 0.13 / 0.16 |
| `minimax-h3-max-ref@480P` / `@768P` / `@1080P` | 0.05 / 0.08 / 0.16 |
| `minimax-h3-max-i2v@480P` / `@768P` / `@1080P` | 0.05 / 0.08 / 0.16 |
| `minimax-h3-ref@480P` / `@768P` / `@2K` / `@4K` | 0.05 / 0.06 / 0.13 / 0.16 |
| `minimax-h3-max-extend@480P` / `@768P` / `@1080P` / `@2K` | 0.05 / 0.08 / 0.16 / 0.32 |
| `kling-3-pro` / `kling-3-pro+audio` | 0.112 / 0.168 |
| `kling-o3-ref` / `kling-o3-ref+audio` | 0.112 / 0.14 |
| `seedance-2.0-mini@480p` / `@720p`, `seedance-2.0-mini-ref@480p` / `@720p` | 0.0721 / 0.1547 |
| `seedance-2.0-ref@720p` / `@1080p` | 0.3034 / 0.682 |
| `wan-3.0-ref@480p` / `@720p` / `@1080p` | 0.05 / 0.10 / 0.20 |
| `veo-3.1-fast` / `veo-3.1-fast+audio` / `veo-3.1-fast@4k` | 0.10 / 0.15 / 0.35 |
| `vidu-q3@360p` / `@540p` / `@720p` / `@1080p` | 0.07 / 0.07 / 0.154 / 0.154 |
| `vidu-q3-ref@360p` / `@540p` / `@720p` / `@1080p` | 0.07 / 0.07 / 0.154 / 0.154 |
| `gemini-omni-1.1-flash@360p` / `@720p` / `@1080p` / `@4k`, same for `gemini-omni-1.1-flash-ref` | 0.03 / 0.10 / 0.15 / 0.30 |

Lookup order: `<alias>@<resolution>`, then `<alias>+audio` when audio is on, then `<alias>`.
`veo-3.1-fast` has a resolution row only for `4k`. At `720p` it takes `veo-3.1-fast+audio` with audio on,
`veo-3.1-fast` with audio off.
Cost = seconds × USD/s + reference-token or reference-image surcharge. `estimate` and the recorded cost use the same function.

**Reference tokens (`minimax-h3-max-ref`, `minimax-h3-max-extend`).** Keys `<alias>#refTokensIncluded` (4096) and
`<alias>#refTokenUsdPer1k` (0.02). Surcharge = max(0, tokens − 4096) × 0.02 / 1000. Tokens:

| Input | Tokens |
| --- | --- |
| Image (first frame and each image ref), by aspect ratio from its PNG/JPEG/WebP header | 1:1 1024, 4:3 1376, 16:9 1824, 5:2 2560 (a ratio in between takes the next row up) |
| Image not resolved yet, or unreadable | 2560 |
| Any audio refs | 1200 in total (fal's 15 s maximum at ~80 tokens/s) |
| Each video ref | 2560, like an unreadable image. A known limit: the estimate does not read the clip, so it can be off for video refs |

Example: 5 s at 768P with four square images is 0.40; with five it is 0.42048. The estimate can only be
higher than fal's bill, never lower, as long as there are no video refs.
For `minimax-h3-max-extend` the source clip is counted like an unreadable image: 2560 tokens, inside the 4096
included. Not verified against a fal bill.

**Reference images (`minimax-h3-ref`).** Keys `minimax-h3-ref#refImagesIncluded` (5) and
`minimax-h3-ref#refImageUsd` (0.08). Surcharge = max(0, images − 5) × 0.08. Images are the first frame and
each image ref; audio and video refs do not count, an unresolved ref counts as an image. Example: 5 s at 768P
with the first frame and five image refs is 0.38.

**H3 Max image-to-video (`minimax-h3-max-i2v`).** Per second only: fal names no reference-token charge for it.
The rate is fal's list rate after the promo ends on 2026-09-30, so the estimate stays an upper bound. The end
frame does not change the price. Example: 5 s at 768P is 0.40.

Seedance 2.5 and 2.0 Mini 1080p have no bundled price. Add `seedance-2.5@1080p` (or
`seedance-2.0-mini@1080p`) to `priceOverrides` to use it.

### Video job protocol

1. **Upload.** `storage`: `POST uploadUrl { file_name, content_type }` → `{ upload_url, file_url }`, then
   `PUT upload_url` with the bytes. The first frame goes first, then every ref (image, audio, video) and the
   end frame, last, in parallel, 4 at a time. On any failure, a `data:<mime>;base64,...` URI for this and later files, logged
   once as `fal:upload:fallback`.
   **Upload cache.** Each storage URL is kept for the process in `state.uploads`, keyed
   `storage:<mime>:<sha256 of the bytes>`. The same face or tail clip is uploaded once, across items,
   attempts and runs, under any path. A data-URI fallback is never cached. The cache lives as long as the
   process; `app.stop()` keeps it.
2. **Submit.** `POST <queueUrl>/<endpoint>` with `Authorization: Key <FAL_KEY>`. The job id is JSON
   `{ endpoint, requestId, statusUrl, responseUrl }`; status and result URLs are used as fal returned them.
3. **Poll.** `GET statusUrl`: `IN_QUEUE` / `IN_PROGRESS` → pending. `COMPLETED` with `error` →
   `{ state: "failed", error }`. `COMPLETED` → `GET responseUrl`, download `video.url` →
   `{ state: "done", video, mimeType, costUsd, meta: { endpoint, requestId, seconds } }`.

## Image

`ImageRequest.model` is one of these aliases (default `imageDefaultModel`). Any other value throws
`Unknown fal image model`. A request with refs goes to the edit endpoint, else to the text endpoint.

| Alias | Text endpoint | Edit endpoint | Max refs | `params.resolution` | Aspects |
| --- | --- | --- | --- | --- | --- |
| `nano-banana-pro` | `fal-ai/nano-banana-pro` | `fal-ai/nano-banana-pro/edit` | 14 | native `1K` / `2K` / `4K`, default `1K`; `1080` → `1K` | `21:9 16:9 3:2 4:3 5:4 1:1 4:5 3:4 2:3 9:16` |
| `seedream-4.5-edit` | `fal-ai/bytedance/seedream/v4.5/text-to-image` | `fal-ai/bytedance/seedream/v4.5/edit` | 10 | `2K` → `image_size: "auto_2K"`; `1080` → preset name; `1K` / `4K` ignored | `9:16 16:9 1:1 3:4 4:3` |
| `gpt-image-2.5` (default) | `openai/gpt-image-2.5/sunburst/text-to-image` | `openai/gpt-image-2.5/sunburst/edit` | 16 | `2K` → 2K size; `1080` or none → preset name; `1K` / `4K` ignored | `9:16 16:9 1:1 3:4 4:3` |

`params.resolution` must be `1K`, `2K`, `4K` or `1080`; any other value is a terminal error. `aspect` defaults to
`9:16` and is checked against the size table of the resolution, when there is one.

| Aspect | Seedream default size | Seedream / GPT `1080` preset | GPT `2K` size |
| --- | --- | --- | --- |
| 9:16 | 1440×2560 | `portrait_16_9` | 1152×2048 |
| 16:9 | 2560×1440 | `landscape_16_9` | 2048×1152 |
| 1:1 | 1920×1920 | `square_hd` | 2048×2048 |
| 3:4 | 1920×2560 | `portrait_4_3` | 1536×2048 |
| 4:3 | 2560×1920 | `landscape_4_3` | 2048×1536 |

Bodies: nano `{ prompt, aspect_ratio, resolution, num_images: 1, output_format: "png", enable_web_search: false, sync_mode: false, image_urls? }`;
seedream `{ prompt, image_size, num_images: 1, max_images: 1, sync_mode: false, image_urls? }`;
gpt `{ prompt, image_size, quality, num_images: 1, output_format: "jpeg", image_urls? }`. `params.quality` (gpt only) is
`low`, `medium` or `high`, else `high`. The prompt sent is `<prompt>\n\nAvoid: <negative>` when `negative` is set.
Every other param passes through, but the mapped fields win: a param never raises `num_images` or changes the size.

Refs must be resolved `{ path, mimeType, hash }` files at `submit`; `estimate` only counts them.
The result is `images[0]`: the MIME type is fal's `content_type`, else the download's `content-type`, else the URL
extension (`png jpg jpeg webp`), else `image/png`. `meta` is `{ model, endpoint, requestId, width?, height? }`.

## prompt-gen

`PromptGenRequest.model` is an OpenRouter id; `undefined` or `"default"` means `llmDefaultModel`. Any other id is
sent as is and needs a price. `app.fal.models("prompt-gen")` lists:

| OpenRouter id | In USD / M tokens | Out USD / M tokens |
| --- | --- | --- |
| `anthropic/claude-opus-5.5` (default) | 4 | 20 |
| `anthropic/claude-sonnet-5` | 2 | 10 |
| `openai/gpt-6-sol` | 2 | 10 |
| `openai/gpt-6-astra` | 10 | 50 |
| `google/gemini-3.8-flash` | 0.75 | 3.75 |
| `x-ai/grok-4.7` | 1.6 | 4.8 |

Also priced, not listed: `anthropic/claude-haiku-4.5` (1 / 5) and `google/gemini-2.5-flash` (0.3 / 2.5).

| Param | Values | Default |
| --- | --- | --- |
| `params.reasoning` | `off` / `low` / `medium` / `high`; `off` sends no `reasoning` | `medium` |
| `params.responseSchema` | a plain JSON schema object → `response_format: { type: "json_schema", json_schema: { name: "answer", schema, strict } }` | none |
| `params.strictSchema` | `true` makes the schema strict | `false` |
| `params.images` | one or many `{ path, mimeType, hash }`, uploaded, sent as `image_url` parts after the text | none |
| `params.max_tokens` | a positive integer | `32000` |
| `temperature` | clamped to 0..2 | not sent |

No other param is copied. The body is `{ model, messages, max_tokens, temperature?, reasoning?, response_format? }`,
with a system message only when `system` is set.

`estimate` needs no key and no network: `tokens(system) + tokens(prompt)` in, `max_tokens` out, at the model's
price (a token is 4 ASCII characters or 1 other character). The actual cost is fal's `usage.cost`, else
`usage.prompt_tokens` / `completion_tokens` at the table price, else the character rule; `meta.costSource` says
which. An answer cut by `max_tokens` is `meta.partial: true` (logged `fal:llm:partial`); a null content cut by
length is `""`. `meta` is `{ modelId, reasoning, provider, finishReason, promptTokens, completionTokens, costSource, partial }`.

## Music

`MusicRequest.model` is required and names one of these aliases; there is no fallback between them.

| Alias | Endpoint | Length | Billing | Body |
| --- | --- | --- | --- | --- |
| `elevenlabs-music-v2.5` | `fal-ai/elevenlabs/music/v2.5` | 3 000–600 000 ms | per started minute | with chunks: `{ composition_plan: { chunks: [{ text, duration_ms, positive_styles, negative_styles? }] }, seed?, output_format: "mp3_48000_192" }`; without: `{ prompt, music_length_ms, force_instrumental: true, output_format: "mp3_48000_192" }` |
| `stable-audio-2.5` | `fal-ai/stable-audio-25/text-to-audio` | 1 000–190 000 ms | per generation | `{ prompt, seconds_total: ceil(lengthMs / 1000), seed? }` |

The request is validated with zod first (the message names the bad field), then: the alias, the model's length
range, and the chunks (each 3 000–120 000 ms, at most 30, adding up to `lengthMs`). Chunks are validated for Stable
Audio too, though its body ignores them. `params` never reach the body. Every failure is a terminal 400, e.g.

```
[ai] Invalid music request: chunks add up to 50000 ms, not 60000.
  Fix the build item that produced it.
```

The result is `audio`: the MIME type is fal's `content_type`, else the download's `content-type`, else the URL
extension (`mp3 wav ogg opus`), else `audio/mpeg`. `meta` is `{ model, endpoint, requestId, lengthMs }`.

## Shared client

**Upload.** Every task uploads the same way: `POST uploadUrl { file_name, content_type }` → `{ upload_url, file_url }`,
then `PUT upload_url`. Files of one call go 4 at a time, in order. A failed upload switches the rest of the session
to data URIs, logged once as `fal:upload:fallback`. Storage URLs are cached in `state.uploads` by
`storage:<mime>:<sha256>`, shared by every task and kept for the life of the process.

**Queue (image, music).** `submit` POSTs `<queueUrl>/<endpoint>` without the caller's signal (a billed job always
returns its id; an abort is checked after the uploads). The job id is JSON `{ endpoint, requestId, statusUrl, responseUrl }`,
the same codec as video. `poll` reads the status once: `IN_QUEUE` / `IN_PROGRESS` pending, `COMPLETED` with `error`
failed, `COMPLETED` collected (result, then the CDN download without the key), an unknown status pending with a
`fal:poll:unknown-status` warn. `execute` waits in process: a retryable status error counts as pending
(`fal:poll:retry`), an abort ends the wait with the signal's reason.

**Request log.** Off by default. With `requestLog` set, every billable request writes one JSONL line: each queue
submit of image and music, and each prompt-gen POST attempt.

```json
{"at":"2026-09-29T10:00:00.000Z","task":"image","model":"gpt-image-2.5","endpoint":"openai/gpt-image-2.5/sunburst/edit","requestId":"019a…","prompt":"hero shot","body":{"image_size":"portrait_16_9","quality":"high","num_images":1,"output_format":"jpeg","image_urls":["face.png"]}}
```

`requestId` is fal's request id (prompt-gen: the answer's `id`); a failed request has `error: { errorType, status?, kind? }`
instead, never the error text. `body` is the posted body without its prompt field (`prompt`, or the chat `messages`),
every string cut: http(s) URLs to `<host>/…/<last segment>`, data URIs to `data:<mime>;<length>`. Ref URLs
(`image_urls`, the chat `image_url` parts) become the file names when there is one per uploaded file, else
`{ count }`. Never the key or a header. A failed write warns `fal:request-log:failed` once and never fails the request.

## Prices

One merged table: each task's bundled rows, then `priceOverrides` (overrides win). Video keys stay unprefixed; the
other tasks' keys carry the task:

| Key | USD | Unit |
| --- | --- | --- |
| `image:nano-banana-pro@1K` / `@2K` / `@4K` | 0.15 / 0.15 / 0.30 | per image |
| `image:seedream-4.5-edit` | 0.04 | per image |
| `image:gpt-image-2.5` | 0.05 | per image |
| `music:elevenlabs-music-v2.5` | 0.80 | per started minute |
| `music:stable-audio-2.5` | 0.20 | per generation |
| `llm:<id>#in` / `llm:<id>#out` | the prompt-gen table | per M tokens |

Image lookup: `image:<alias>@<resolution>` when a resolution is planned, then `image:<alias>`. A missing price is
a terminal error before any upload or charge:

```
[ai] No price for fal image model "gpt-image-2.5".
  Add it to fal.priceOverrides.
```

Video keys, lookup and surcharges are in [Video prices](#video-prices-usd-per-second).

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
| `FAL_KEY` not set, unknown model, missing image, too many refs, end frame on a model without one | Plain error: terminal after one attempt, nothing billed |
| Poll with `FAL_KEY` not set, or the status call answers 401 / 403 | Plain error with no `status` and no `kind` (`[ai] fal cannot poll without a valid API key.`): the runner marks the job `expired`, not `failed`, so the next run adopts the same job instead of paying again |
| Image, prompt-gen or music: unknown model, too many refs, bad resolution, aspect or params, invalid music request, missing price | `TerminalProviderError` (400) before the key is read, anything is uploaded or anything is billed |
| Image or music: result or download of a `COMPLETED` job answers 400 / 422, or is flagged | `failed`: fal's verdict, logged `fal:image:failed` / `fal:music:failed` |
| Image or music: result or download fails with another 4xx | Retryable 503 (`fal:result:unreadable`), same rule as video |
| Image or music `execute`: the in-process wait passes `jobTimeoutMs` | Retryable, `kind: "timeout"`; the job keeps running on fal and stays adoptable through `poll` |
| prompt-gen: 401 / 403 | `PromptGenUnavailableError`, reason `auth`, never retried: `promptGen` moves to its next fallback provider |
| prompt-gen: 402 / 429 | `PromptGenUnavailableError`, reason `limit`, never retried |
| prompt-gen: 5xx or request timeout | Retried in the handler, 3 attempts at most, backoff 1 s then 2 s (logged `fal:llm:retry`) |
| prompt-gen: a 2xx answer with `error.message` | Flagged when it names `content_policy`, else terminal 400 `[ai] fal LLM returned an error: <text>` |
| Incomplete result body (no `images[0].url`, `audio.url`, `choices[0].message.content`) | Plain two-line error |

Messages start with `[ai]` and never contain the key or the prompt. Logs carry ids, statuses, counts and error
classes, never prompts.

## API

```ts
app.fal.info(); // => { provider: "fal", configured: true, models: ["seedance-2.5", ...] }
app.fal.models("prompt-gen")[0]; // => { id: "anthropic/claude-opus-5.5", price: { inputPerM: 4, outputPerM: 20 } }
app.fal.models("music"); // => [{ id: "elevenlabs-music-v2.5", price: { usd: 0.8, per: "minute" } }, { id: "stable-audio-2.5", price: { usd: 0.2, per: "generation" } }]
app.fal.models("image")[0]; // => { id: "nano-banana-pro", price: { usd: 0.15, per: "image" } }
app.fal.models("video")[0]; // => { id: "seedance-2.5", price: { usd: 0.473, per: "second" } }
```

`info()` is unchanged: `configured` is true when `FAL_KEY` (or the configured variable) is set; `models` are the
video aliases. `models(task)` lists one task's models in catalog order with their effective price (video and image
at the model's default resolution, video with audio off and no refs); no network, no key. The price shape narrows
on `"inputPerM" in info.price`. Any other task string throws `[ai] Unknown fal task "x".`

## Usage

```yaml
items:
  - id: s01.key
    task: image
    provider: fal
    input: { prompt: "patisserie counter at night", model: "nano-banana-pro", aspect: "9:16", params: { resolution: "2K" } }
  - id: s01.kling
    task: video
    provider: fal
    input:
      model: kling-3-pro
      prompt: "slow push-in, she smiles"
      image: { $ref: s01.key }
      seconds: 5
      audio: true
  - id: s01.score
    task: music
    provider: fal
    input: { prompt: "tense synth pulse", model: "elevenlabs-music-v2.5", lengthMs: 60000 }
```

```ts
app.video.estimate({ model: "minimax-h3", prompt: "push-in", seconds: 5 }, { provider: "fal" }); // { usd: 0.3 }
app.music.estimate({ prompt: "x", model: "stable-audio-2.5", lengthMs: 30_000 }, { provider: "fal" }); // { usd: 0.2 }
await app.promptGen.generate({ prompt: "Caption a sunset in five words." }, { provider: "fal" });
```
