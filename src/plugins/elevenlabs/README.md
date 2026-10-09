# elevenlabs

> The ElevenLabs provider adapter — a Complex-tier plugin that owns everything ElevenLabs-specific and registers the `("voiceover", "elevenlabs")`, `("sfx", "elevenlabs")` and `("music", "elevenlabs")` capabilities with the registry.

## Purpose

`@moku-labs/ai` is a declarative build system for AI-generated assets: task plugins (like
[`voiceover`](../voiceover)) define *what* can be generated, provider plugins define *who* can
generate it, and the [`registry`](../registry) connects the two. The `elevenlabs` plugin is the
provider side of that contract for ElevenLabs: it owns a thin internal `fetch` client (no SDK
dependency — one TTS endpoint doesn't justify one), a bundled per-character price table, and
per-task handler submodules. It implements three capabilities, all registered in `onInit`:
text-to-speech via `POST /v1/text-to-speech/{voiceId}` under `("voiceover", "elevenlabs")`,
sound effects via `POST /v1/sound-generation` under `("sfx", "elevenlabs")`, and music via
`POST /v1/music` under `("music", "elevenlabs")`.

The plugin follows the provider-owns-all-tasks shape: each capability is a sibling submodule
(`voiceover/`, `sfx/`, `music/`). Per-task submodules never import each other — they
coordinate through the plugin's root state (the shared, lazily-computed price table in
`prices.ts` / `state.ts`).

## Configuration

Set via `createApp({ pluginConfigs: { elevenlabs: { ... } } })`. All keys have defaults; the
plugin works out of the box once the API key env var is exported.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKeyEnv` | `string` | `"ELEVENLABS_API_KEY"` | Name of the env var holding the API key. Resolved via `ctx.env` at request time — never stored, never logged. |
| `baseUrl` | `string` | `"https://api.elevenlabs.io"` | API base URL. |
| `defaultModel` | `string` | `"eleven_multilingual_v2"` | Model used when a request doesn't name one. |
| `timeoutMs` | `number` | `60_000` | Per-request timeout, ms (enforced via `AbortSignal.timeout`, merged with any caller signal). |
| `musicTimeoutMs` | `number` | `600_000` | Timeout of one music request, ms. `/v1/music` answers only when the whole track is ready. |
| `priceOverrides` | `Record<string, number>` | `{}` | Price overrides, merged over the bundled table (overrides win). Voice models: USD per character, keyed by model id. sfx: `sfx:<model>#second` (USD per started second) and `sfx:<model>#auto` (USD for a model-picked length). music: `music:<model>` (USD per started minute). |

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({
  pluginConfigs: {
    elevenlabs: {
      apiKeyEnv: "MY_ELEVENLABS_KEY",
      defaultModel: "eleven_turbo_v2_5",
      priceOverrides: { eleven_turbo_v2_5: 0.000_12 }
    }
  }
});
```

### Environment variables

| Variable | Required | Read | Purpose |
| --- | --- | --- | --- |
| `ELEVENLABS_API_KEY` (or whatever `apiKeyEnv` names) | For `execute()` only | At request time, via `ctx.env.get` | Sent as the `xi-api-key` header. |

There is no account pool in this plugin — it resolves exactly one key from the configured env
var. `info()` and `estimate()` never require the key; only `execute()` does. When the variable
is unset, `execute()` throws **before any network call** with the pinned two-line error
(interpolating the configured name):

```
[ai] ELEVENLABS_API_KEY is not set.
  Export it or set config.apiKeyEnv to the variable that holds your key.
```

### Bundled price table

`prices.ts` ships approximate defaults; override precisely via `priceOverrides` for your
account's actual tier.

| Model | USD / character |
| --- | --- |
| `eleven_multilingual_v2` | 0.0003 |
| `eleven_turbo_v2_5` | 0.000_15 |
| `eleven_flash_v2_5` | 0.000_06 |
| `eleven_monolingual_v1` | 0.0003 |

| sfx key | USD |
| --- | --- |
| `sfx:eleven_text_to_sound_v2#second` | 0.002 per started second |
| `sfx:eleven_text_to_sound_v2#auto` | 0.01 per generation, when the request has no `durationMs` |

The sfx prices are an estimate. ElevenLabs bills 40 credits per second and 200 credits for an
auto-length sound ([help article](https://help.elevenlabs.io/hc/en-us/articles/25735337678481)),
and lists the SFX API at $0.12 per minute ([pricing](https://elevenlabs.io/pricing/api)), both
checked 2026-10-04. The per-credit USD rate is not published. Set the real price for your plan:

```ts
createApp({
  pluginConfigs: {
    elevenlabs: { priceOverrides: { "sfx:eleven_text_to_sound_v2#second": 0.0025 } }
  }
});
```

| music key | USD |
| --- | --- |
| `music:music_v1` | 0.15 per started minute |
| `music:music_v2` | 0.15 per started minute |
| `music:music_v2_5` | 0.15 per started minute |

The music prices are an estimate. ElevenLabs lists the Music API at $0.15 per minute, one price
for every music model ([pricing](https://elevenlabs.io/pricing/api), checked 2026-10-09). The
page does not say how a part of a minute is billed, so the handler counts every started minute.

The effective table (bundled ∪ overrides) is computed once at first use and cached in plugin
state. Voice models absent from the effective table estimate at `$0`. A missing sfx or music
price is a terminal error instead, because a paid job never runs at an unknown price (see the sfx handler).

## API reference

### `app.elevenlabs.*` — observability surface

`app.elevenlabs` is deliberately thin. The real capability surface is the `VoiceoverHandler`
registered with `registry` — consume it through `app.voiceover` (the task facade) or
`app.runner` (the durable pipeline), never directly.

#### `info(): { provider: "elevenlabs"; configured: boolean; models: string[] }`

Provider health/info for `moku status` and docs.

- **Params:** none.
- **Returns:** `provider` (always `"elevenlabs"`), `configured` (whether the configured API key
  env var is present — checked via `ctx.env.has`, never throws), and `models` (the voice model
  ids known to the effective price table, including any `priceOverrides` additions; `sfx:` price
  rows are left out).
- **Throws:** never.

```ts
app.elevenlabs.info();
// => { provider: "elevenlabs", configured: true, models: ["eleven_multilingual_v2", ...] }
```

### Registered handler — `("voiceover", "elevenlabs")`

`voiceover/handler.ts` implements the task-owned `VoiceoverHandler` contract
(`../voiceover/contract.ts`) and is registered in `onInit`. Reachable as
`app.voiceover.generate(request, { provider: "elevenlabs" })` — or with no `provider` at all
when elevenlabs registered first.

#### `estimate(request: VoiceoverRequest): { usd: number }`

Cost estimate: `request.text.length × price-per-character` for the resolved model
(`request.model ?? config.defaultModel`). Pure arithmetic — never touches the network, never
needs the API key. This is the same estimate the runner's budget gate calls.

```ts
app.voiceover.estimate({ text: "Hello, world!", voice: "21m00Tcm4TlvDq8ikWAM" });
// => { usd: 0.0000039 }
```

#### `execute(request: VoiceoverRequest, opts: { signal?: AbortSignal }): Promise<VoiceoverResult>`

Synthesizes speech.

- **Params:** `request` — `text`, `voice` (ElevenLabs voice id), optional `language` (mapped to
  `language_code`), `model`, `format` (`"mp3"` | `"wav"` | `"ogg"`, default `"mp3"`), and
  `params` (spread into the JSON body last, so request-supplied fields win on key conflicts).
  `opts.signal` — aborting it cancels the in-flight fetch; the abort propagates unchanged
  (clean-pause), never reclassified as a timeout.
- **Behavior:** resolves the API key via `ctx.env` (throws the pinned "not set" error first),
  then POSTs to `/v1/text-to-speech/{voiceId}?output_format=...` — `mp3` → `mp3_44100_128`,
  `wav` → `pcm_44100`, `ogg` → `ogg_44100`.
- **Returns:** `VoiceoverResult` — `audio` (`Uint8Array`), `mimeType` (`audio/mpeg` |
  `audio/wav` | `audio/ogg`), `costUsd` (same math as `estimate`), and
  `meta: { model, characters }`.
- **Throws:** the provider error taxonomy below, or the missing-key `Error`.

```ts
const result = await app.voiceover.generate(
  { text: "Hello, world!", voice: "21m00Tcm4TlvDq8ikWAM", format: "mp3" },
  { provider: "elevenlabs" }
);
// result.audio: Uint8Array, result.mimeType: "audio/mpeg", result.costUsd: number
```

### Registered handler — `("sfx", "elevenlabs")`

`sfx/handler.ts` implements the task-owned `SfxHandler` contract (`../sfx/contract.ts`) and is
registered in `onInit`, after voiceover. Reachable as
`app.sfx.generate(request, { provider: "elevenlabs" })`. elevenlabs is the sfx default provider.

The output is always mp3 (`audio/mpeg`): the game engine accepts mp3 only.

#### Request rules

Every rule is checked before any HTTP call. A refused request throws
`TerminalProviderError` with `status: 400`, so the runner marks the item `failed` and never
retries it. The messages never contain the prompt text.

| Field | Rule |
| --- | --- |
| `model` | Must be `"eleven_text_to_sound_v2"`. |
| `prompt` | At most 450 characters. Sent as `text`. |
| `durationMs` | Optional. 500..30000. Sent as `duration_seconds` (`durationMs / 1000`). Omitted means the model picks the length. |
| `promptInfluence` | Optional. 0..1. Sent as `prompt_influence`. |
| `loop` | Optional boolean. Sent as `loop`. |
| `params.output_format` | Optional. Must start with `mp3_`, for example `"mp3_22050_32"`. Default `"mp3_44100_128"`. Any other format throws. This is the only `params` key the handler reads. |

#### `estimate(request: SfxRequest): { usd: number }`

Checks `model` and `durationMs` only, then prices the request. It reads no other field, because
the runner estimates a request before its references are resolved. It never touches the network
and never needs the API key.

- `durationMs` set: `ceil(durationMs / 1000) × price["sfx:<model>#second"]`.
- `durationMs` omitted: `price["sfx:<model>#auto"]`.
- A missing price throws `TerminalProviderError(400)`:

```
[ai] No price for ElevenLabs sfx model "eleven_text_to_sound_v2".
  Add it to elevenlabs.priceOverrides.
```

```ts
app.sfx.estimate({ prompt: "sword hit, metallic", model: "eleven_text_to_sound_v2", durationMs: 1500 });
// => { usd: 0.004 } (2 started seconds × 0.002)
app.sfx.estimate({ prompt: "sword hit, metallic", model: "eleven_text_to_sound_v2" });
// => { usd: 0.01 }
```

#### `execute(request: SfxRequest, opts: { signal?: AbortSignal }): Promise<SfxResult>`

Checks every rule above, prices the request, reads the API key, then POSTs
`{ text, model_id, duration_seconds?, prompt_influence?, loop? }` to
`/v1/sound-generation?output_format=<mp3 format>`. `opts.signal` cancels the in-flight fetch, and
the abort propagates unchanged.

- **Returns:** `SfxResult` — `audio` (`Uint8Array`), `mimeType: "audio/mpeg"`, `costUsd` (same
  math as `estimate`), and `meta: { model, outputFormat, durationMs? }`.
- **Throws:** the request-rule and missing-price errors above, the missing-key `Error`, or the
  provider error taxonomy below.

```ts
const hit = await app.sfx.generate(
  { prompt: "sword hit, metallic", model: "eleven_text_to_sound_v2", durationMs: 800 },
  { provider: "elevenlabs" }
);
await Bun.write("sword-hit.mp3", hit.audio); // hit.mimeType === "audio/mpeg", hit.costUsd === 0.002
```

### Registered handler — `("music", "elevenlabs")`

Implements the `MusicHandler` contract owned by the [`music`](../music) plugin, over
`POST /v1/music` with the `xi-api-key` header
([Compose music](https://elevenlabs.io/docs/api-reference/music/compose),
[authentication](https://elevenlabs.io/docs/api-reference/authentication), both checked
2026-10-09). The endpoint is synchronous and answers with the audio file, so the handler offers
`estimate` + `execute` and no `submit` + `poll`. The default provider of `music` stays `fal`:
name this one with `provider: elevenlabs`.

The Music API is for paid plans only
([Music quickstart](https://elevenlabs.io/docs/eleven-api/guides/cookbooks/music): "only
available to paid users"). On a free plan the call fails with an HTTP 4xx.

#### Request rules

Every rule is checked before any HTTP call. A broken rule throws `TerminalProviderError` with
status 400. A field the API cannot take is refused, never dropped. The source of every rule is
the [Compose music](https://elevenlabs.io/docs/api-reference/music/compose) page.

| Field | Rule |
| --- | --- |
| `model` | `"music_v1"`, `"music_v2"` or `"music_v2_5"`. Sent as `model_id`. The fal alias `"elevenlabs-music-v2.5"` is refused. |
| `lengthMs` | Whole number, 3000..600000. With a prompt it is sent as `music_length_ms`. |
| `prompt` | Sent as `prompt` when the request has no `chunks`. Must not be empty. With `chunks` it is not sent: the API takes `prompt` or `composition_plan`, never both. |
| `chunks` | Sent as `composition_plan.chunks`: `text`, `durationMs` → `duration_ms`, `styles` → `positive_styles`, `avoid` → `negative_styles`. Only `music_v2` and `music_v2_5`. `music_v1` takes a `sections` plan that `MusicChunk` cannot express, so chunks on `music_v1` throw. |
| `chunks[].durationMs` | Whole number, 3000..120000. The API takes no `music_length_ms` next to a plan, so the durations must add up to `lengthMs`. |
| `chunks[].text` | At most 30 lines, each at most 200 characters. |
| `seed` | Only with `chunks`, a whole number. The API refuses `seed` next to `prompt`, so a seed on a prompt request throws. |
| `params.force_instrumental` | Optional boolean, only with a prompt. Default `true`, the same instrumental default as the fal handler. With `chunks` it throws. |
| `params.output_format` | Optional. Must start with `mp3_`, for example `"mp3_44100_192"`. Unset sends no query value: the API then picks `mp3_44100_128` for `music_v1` and `mp3_48000_192` for the v2 models. |
| any other `params` key | Throws. |

Not mapped, because `MusicRequest` has no field for them: `finetune_id`, `store_for_inpainting`,
`sign_with_c2pa`, `respect_sections_durations`, chunk `context_adherence`, `conditioning_ref`
and `condition_strength`, and the `pcm_`, `opus_`, `ulaw_` and `alaw_` output formats.

#### `estimate(request: MusicRequest): { usd: number }`

Checks `model` and `lengthMs` only, then prices every started minute at `music:<model>`. No
key, no network.

```ts
app.music.estimate(
  { prompt: "tense synth pulse", model: "music_v2_5", lengthMs: 65_000 },
  { provider: "elevenlabs" }
); // => { usd: 0.3 }
```

#### `execute(request: MusicRequest, opts: { signal?: AbortSignal }): Promise<MusicResult>`

Checks every rule, prices the request, reads the key, then POSTs and waits up to
`musicTimeoutMs`. Returns `{ audio, mimeType: "audio/mpeg", costUsd, meta: { model, lengthMs,
outputFormat? } }`.

```ts
const track = await app.music.generate(
  { prompt: "tense synth pulse", model: "music_v2_5", lengthMs: 60_000 },
  { provider: "elevenlabs" }
);
await Bun.write("teaser.mp3", track.audio);
```

In a build file:

```yaml
  - id: s01.score
    task: music
    provider: elevenlabs
    input: { model: music_v2_5, prompt: "tense synth pulse", lengthMs: 30000 }
  - id: s01.theme
    task: music
    provider: elevenlabs
    input:
      model: music_v2_5
      prompt: "main theme"
      lengthMs: 43000
      seed: 7
      chunks:
        - { text: "[Intro]", durationMs: 13000, styles: [synthwave, dark, slow build] }
        - { text: "[Drop]", durationMs: 30000, styles: [driving bass], avoid: [vocals] }
```

A content refusal is `FlaggedProviderError`. The API returns `detail.status` `bad_prompt` or
`bad_composition_plan` for copyrighted material, such as a band name or known lyrics
([Music quickstart](https://elevenlabs.io/docs/eleven-api/guides/cookbooks/music)). The
suggested rewrite in the response is not read into the error or the log.

A timeout is retryable, so the runner sends the request again. ElevenLabs may bill the first
attempt. Raise `musicTimeoutMs` if long tracks time out.

### Error taxonomy

`client.ts` classifies every failure into one of three `Error` subclasses (defined in this
plugin's `errors.ts` and exported as values via the `ElevenlabsErrors` namespace). Each carries the
structural fields the runner's `classifyError` (`../runner/retry.ts`) reads by shape alone
(`status` / `kind` / `retryAfterMs`) — no cross-plugin error-class import anywhere.

| Failure | Error class | Structural fields | Runner bucket |
| --- | --- | --- | --- |
| HTTP 5xx | `RetryableProviderError` | `status: <code>` | `http-5xx` — retried |
| HTTP 429 | `RetryableProviderError` | `status: 429`, `retryAfterMs` (parsed from `Retry-After`, seconds or HTTP-date) | `http-429` — retried |
| Request timeout | `RetryableProviderError` | `kind: "timeout"` | `timeout` — retried |
| Network failure | `RetryableProviderError` | `kind: "network"` | `network` — retried |
| Other HTTP 4xx | `TerminalProviderError` | `status: <code>` | `http-4xx` — terminal `failed` |
| `detail.status` is `"content_policy_violation"`, `"bad_prompt"` or `"bad_composition_plan"` | `FlaggedProviderError` | `kind: "content-policy"` | `content-policy` — terminal `flagged`, never re-queued |

A content-policy `detail.status` in the error body wins over the numeric status code. A
caller-initiated abort (via `opts.signal`) rethrows the original abort error, unclassified.

**Redaction rule:** thrown messages, `meta`, and `ctx.log` calls never echo request text or
response bodies — only status codes and error classes.

### Exported types and classes

The plugin instance is exported from `"@moku-labs/ai"` as `elevenlabsPlugin`; its types are
re-exported under the `Elevenlabs` namespace, and its error classes (values) under the
`ElevenlabsErrors` namespace:

```ts
import { Elevenlabs, ElevenlabsErrors, elevenlabsPlugin } from "@moku-labs/ai";

type Cfg = Elevenlabs.Config; // { apiKeyEnv, baseUrl, defaultModel, timeoutMs, priceOverrides }
type Api = Elevenlabs.ElevenlabsApi; // { info() }

// Error classes (values) for instanceof checks in custom pipelines:
ElevenlabsErrors.RetryableProviderError;
ElevenlabsErrors.TerminalProviderError;
ElevenlabsErrors.FlaggedProviderError;

// `Elevenlabs.<Class>` still works in type position:
type Retryable = Elevenlabs.RetryableProviderError;
```

## Events

None. The plugin emits nothing and listens to nothing (per spec). Its only diagnostics are
structured logs through `ctx.log`:

| Log call | Level | Payload | When |
| --- | --- | --- | --- |
| `elevenlabs:voiceover:done` | `info` | `{ model, format }` | After a successful generation. |
| `elevenlabs:voiceover:failed` | `warn` | `{ errorType, status?, kind? }` (redacted — never message text) | Before rethrowing any `execute()` failure. |
| `elevenlabs:sfx:done` | `info` | `{ model, outputFormat }` | After a successful sound generation. |
| `elevenlabs:sfx:failed` | `warn` | `{ errorType, status?, kind? }` (redacted — never message text) | Before rethrowing an HTTP failure of sfx `execute()`. Request-rule errors are thrown without a log. |

| `elevenlabs:music:done` | `info` | `{ model, lengthMs, bytes }` | After a successful music generation. |
| `elevenlabs:music:failed` | `warn` | `{ errorType, status?, kind? }` (redacted — never message text) | Before rethrowing an HTTP failure of music `execute()`. Request-rule errors are thrown without a log. |

## Usage examples

### One-off generation through the task facade

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({});
await app.start();

// Check the provider is ready before spending money.
const { configured } = app.elevenlabs.info();
if (!configured) throw new Error("Export ELEVENLABS_API_KEY first.");

// Estimate, then generate.
const { usd } = app.voiceover.estimate({ text: "Welcome back!", voice: "21m00Tcm4TlvDq8ikWAM" });
console.log(`Estimated: $${usd}`);

const result = await app.voiceover.generate({
  text: "Welcome back!",
  voice: "21m00Tcm4TlvDq8ikWAM",
  language: "en",
  format: "ogg"
});
await Bun.write("welcome.ogg", result.audio);

await app.stop();
```

### Cancellation

```ts
const controller = new AbortController();
const pending = app.voiceover.generate(
  { text: "A very long narration…", voice: "21m00Tcm4TlvDq8ikWAM" },
  { provider: "elevenlabs", signal: controller.signal }
);

controller.abort(); // cancels the in-flight HTTP request cleanly
```

### Handling the error taxonomy directly

```ts
import { ElevenlabsErrors } from "@moku-labs/ai";

try {
  await app.voiceover.generate({ text: "Hi", voice: "21m00Tcm4TlvDq8ikWAM" });
} catch (error) {
  if (error instanceof ElevenlabsErrors.RetryableProviderError) {
    console.warn("transient — retry later", error.status ?? error.kind, error.retryAfterMs);
  } else if (error instanceof ElevenlabsErrors.FlaggedProviderError) {
    console.error("content policy — do not re-queue");
  } else {
    throw error;
  }
}
```

`instanceof` and `new` need the value from `ElevenlabsErrors`. `Elevenlabs.RetryableProviderError`
(and the other two) still work in type position, for example `let last: Elevenlabs.RetryableProviderError`.

## Integration

- **Registration.** `onInit` calls
  `register("voiceover", "elevenlabs", createVoiceoverHandler(ctx))`, then
  `register("sfx", "elevenlabs", createSfxHandler(ctx))`, then
  `register("music", "elevenlabs", createMusicHandler(ctx))`, on `ctx.require(registryPlugin)`.
  Registration is a synchronous map insertion, so there is no `onStart`/`onStop` — the fetch
  client is stateless and holds no connections. After startup the provider is visible in
  `app.voiceover.providers()`, `app.sfx.providers()`, `app.music.providers()` and `app.registry.providers(task)`;
  registration order in `src/index.ts` makes the *first*-registered provider the task default.
- **Tasks fulfilled:** `voiceover`, `sfx` and `music`.
- **Runner retry interplay.** When a build runs through `app.runner`, the runner catches
  `execute()` failures and classifies them structurally via `classifyError`
  (`../runner/retry.ts`): `RetryableProviderError` instances are re-queued with exponential,
  jittered backoff — and a 429's `retryAfterMs` overrides the computed backoff when larger —
  while `TerminalProviderError` marks the item `failed` and `FlaggedProviderError` marks it
  `flagged` (never re-queued). The plugin's error classes were designed field-for-field against
  that classifier, so no error class is ever imported across the plugin boundary.
- **Rate limiting.** This plugin performs no admission control of its own; the
  [`limits`](../limits) plugin throttles pipeline work per lane
  (`"{task}/{provider}"`, e.g. `voiceover/elevenlabs`) with token-bucket rate, concurrency
  ceilings, and a circuit breaker. `Retry-After` hints surfaced by this plugin's 429 errors feed
  the runner's backoff, complementing (not replacing) lane-level throttling.
- **Dependencies:** [`registry`](../registry) only (declared via `depends`). Core-injected
  `ctx.env` (API key resolution) and `ctx.log` (redacted diagnostics) come from the framework's
  `logPlugin`/`envPlugin` registration — no package dependencies; the client uses global `fetch`
  (Node ≥ 24 and Bun).

## File map

| File | Role |
| --- | --- |
| `index.ts` | Plugin definition (`createPlugin`), defaults, `onInit` registration. |
| `types.ts` | `Config` / `State` / `ElevenlabsApi`, type-only re-exports of the three provider error classes, `RegistryApi` re-export (declared once in `registry/index.ts`), `ElevenlabsContext`. No runtime values. |
| `errors.ts` | The three provider error classes (values, exported as `ElevenlabsErrors`) and their module-private `RetryHint`. Imports nothing from `types.ts`. |
| `api.ts` | `createElevenlabsApi` — the `info()` surface. |
| `client.ts` | Thin generic fetch client: request execution, timeout/signal merging, HTTP failure classification. |
| `prices.ts` | Bundled price table + `mergePrices` / `resolvePrices` (lazy cache into state), `sfxPriceOf` and `musicPriceOf` (missing price is terminal), `isSfxPriceKey` and `isMusicPriceKey`. |
| `support.ts` | What every handler shares: `resolveApiKey` and `redactedFailureOf`. |
| `state.ts` | `createElevenlabsState` — `{ prices: null }` sentinel. |
| `voiceover/handler.ts` | The `VoiceoverHandler` implementation: request mapping, cost math, redacted logging. |
| `sfx/handler.ts` | The `SfxHandler` implementation: request rules, mp3 guard, per-second or auto cost, redacted logging. |
| `music/handler.ts` | The `MusicHandler` implementation: request rules, prompt or chunk plan body, per-minute cost, redacted logging. |
