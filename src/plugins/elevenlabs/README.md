# elevenlabs

> The ElevenLabs provider adapter — a Complex-tier plugin that owns everything ElevenLabs-specific and registers the `("voiceover", "elevenlabs")` capability with the registry.

## Purpose

`@moku-labs/ai` is a declarative build system for AI-generated assets: task plugins (like
[`voiceover`](../voiceover)) define *what* can be generated, provider plugins define *who* can
generate it, and the [`registry`](../registry) connects the two. The `elevenlabs` plugin is the
provider side of that contract for ElevenLabs: it owns a thin internal `fetch` client (no SDK
dependency — one TTS endpoint doesn't justify one), a bundled per-character price table, and
per-task handler submodules. At M0 it implements one capability — text-to-speech via
`POST /v1/text-to-speech/{voiceId}` — registered under `("voiceover", "elevenlabs")` in `onInit`.

The plugin follows the provider-owns-all-tasks shape: future capabilities (sfx, music) land as
sibling submodules next to `voiceover/`. Per-task submodules never import each other — they
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
| `priceOverrides` | `Record<string, number>` | `{}` | Per-model USD-per-character overrides, merged over the bundled table (overrides win). |

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

`prices.ts` ships approximate USD-per-character defaults; override precisely via
`priceOverrides` for your account's actual tier.

| Model | USD / character |
| --- | --- |
| `eleven_multilingual_v2` | 0.0003 |
| `eleven_turbo_v2_5` | 0.000_15 |
| `eleven_flash_v2_5` | 0.000_06 |
| `eleven_monolingual_v1` | 0.0003 |

The effective table (bundled ∪ overrides) is computed once at first use and cached in plugin
state; models absent from the effective table estimate at `$0`.

## API reference

### `app.elevenlabs.*` — observability surface

`app.elevenlabs` is deliberately thin. The real capability surface is the `VoiceoverHandler`
registered with `registry` — consume it through `app.voiceover` (the task facade) or
`app.runner` (the durable pipeline), never directly.

#### `info(): { provider: "elevenlabs"; configured: boolean; models: string[] }`

Provider health/info for `moku status` and docs.

- **Params:** none.
- **Returns:** `provider` (always `"elevenlabs"`), `configured` (whether the configured API key
  env var is present — checked via `ctx.env.has`, never throws), and `models` (the model ids
  known to the effective price table, including any `priceOverrides` additions).
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

### Error taxonomy

`client.ts` classifies every failure into one of three `Error` subclasses (defined in this
plugin's `types.ts` and exported via the `Elevenlabs` types namespace). Each carries the
structural fields the runner's `classifyError` (`../runner/retry.ts`) reads by shape alone
(`status` / `kind` / `retryAfterMs`) — no cross-plugin error-class import anywhere.

| Failure | Error class | Structural fields | Runner bucket |
| --- | --- | --- | --- |
| HTTP 5xx | `RetryableProviderError` | `status: <code>` | `http-5xx` — retried |
| HTTP 429 | `RetryableProviderError` | `status: 429`, `retryAfterMs` (parsed from `Retry-After`, seconds or HTTP-date) | `http-429` — retried |
| Request timeout | `RetryableProviderError` | `kind: "timeout"` | `timeout` — retried |
| Network failure | `RetryableProviderError` | `kind: "network"` | `network` — retried |
| Other HTTP 4xx | `TerminalProviderError` | `status: <code>` | `http-4xx` — terminal `failed` |
| `detail.status === "content_policy_violation"` | `FlaggedProviderError` | `kind: "content-policy"` | `content-policy` — terminal `flagged`, never re-queued |

A content-policy `detail.status` in the error body wins over the numeric status code. A
caller-initiated abort (via `opts.signal`) rethrows the original abort error, unclassified.

**Redaction rule:** thrown messages, `meta`, and `ctx.log` calls never echo request text or
response bodies — only status codes and error classes.

### Exported types and classes

The plugin instance is exported from `"@moku-labs/ai"` as `elevenlabsPlugin`; its types are
re-exported under the `Elevenlabs` namespace:

```ts
import { Elevenlabs, elevenlabsPlugin } from "@moku-labs/ai";

type Cfg = Elevenlabs.Config; // { apiKeyEnv, baseUrl, defaultModel, timeoutMs, priceOverrides }
type Api = Elevenlabs.ElevenlabsApi; // { info() }

// Error classes (values) for instanceof checks in custom pipelines:
Elevenlabs.RetryableProviderError;
Elevenlabs.TerminalProviderError;
Elevenlabs.FlaggedProviderError;
```

## Events

None. The plugin emits nothing and listens to nothing (per spec). Its only diagnostics are
structured logs through `ctx.log`:

| Log call | Level | Payload | When |
| --- | --- | --- | --- |
| `elevenlabs:voiceover:done` | `info` | `{ model, format }` | After a successful generation. |
| `elevenlabs:voiceover:failed` | `warn` | `{ errorType, status?, kind? }` (redacted — never message text) | Before rethrowing any `execute()` failure. |

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
import { Elevenlabs } from "@moku-labs/ai";

try {
  await app.voiceover.generate({ text: "Hi", voice: "21m00Tcm4TlvDq8ikWAM" });
} catch (error) {
  if (error instanceof Elevenlabs.RetryableProviderError) {
    console.warn("transient — retry later", error.status ?? error.kind, error.retryAfterMs);
  } else if (error instanceof Elevenlabs.FlaggedProviderError) {
    console.error("content policy — do not re-queue");
  } else {
    throw error;
  }
}
```

## Integration

- **Registration.** `onInit` calls
  `ctx.require(registryPlugin).register("voiceover", "elevenlabs", createVoiceoverHandler(ctx))`.
  Registration is a synchronous map insertion, so there is no `onStart`/`onStop` — the fetch
  client is stateless and holds no connections. After startup the provider is visible in
  `app.voiceover.providers()` and `app.registry.providers("voiceover")`; registration order in
  `src/index.ts` makes the *first*-registered provider the task default.
- **Task fulfilled:** `voiceover` (the only capability at M0).
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
| `types.ts` | `Config` / `State` / `ElevenlabsApi`, the three provider error classes, `RegistryApi` redeclaration, `ElevenlabsContext`. |
| `api.ts` | `createElevenlabsApi` — the `info()` surface. |
| `client.ts` | Thin generic fetch client: request execution, timeout/signal merging, HTTP failure classification. |
| `prices.ts` | Bundled price table + `mergePrices` / `resolvePrices` (lazy cache into state). |
| `state.ts` | `createElevenlabsState` — `{ prices: null }` sentinel. |
| `voiceover/handler.ts` | The `VoiceoverHandler` implementation: request mapping, cost math, redacted logging. |
