# openai

> OpenAI provider adapter — one plugin, three capabilities: voiceover (tts), translate, and prompt-gen via the official `openai` SDK.

## Purpose

`openai` is a provider plugin: it owns every OpenAI capability in the build system through the
official fetch-based `openai` SDK (v5+, no axios). It does not define any task of its own —
instead it implements the task-owned contracts of three task plugins and registers a handler for
each in `onInit`: `("voiceover", "openai")` from the tts submodule, `("translate", "openai")` and
`("prompt-gen", "openai")` from two chat-based submodules. Task facades (`app.voiceover`,
`app.translate`, `app.promptGen`) and the `runner` pipeline resolve those handlers through the
`registry` — consumers never call this plugin's handlers directly.

The plugin earns its Complex tier by covering three capabilities behind one shared boundary:
submodules never import each other; the lazy SDK client (`client.ts`) and the bundled price table
plus cost math (`prices.ts`) live at the plugin root and are shared by all three handlers. The
plugin's job is to translate each task contract into SDK calls, price every request in USD (both
pre-flight estimates for the runner's budget gate and usage-based actual costs), and map every
SDK failure onto the runner's retry taxonomy — with strict redaction (prompts, completions, and
API keys never appear in errors, logs, or result metadata).

## Configuration

Configured under the `openai` key of `pluginConfigs`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKeyEnv` | `string` | `"OPENAI_API_KEY"` | Name of the env var holding the API key. Resolved via `ctx.env.get` at request time — never at init, never logged or echoed. |
| `baseUrl` | `string` (optional) | `undefined` | API base URL override for proxies / OpenAI-compatible endpoints. When omitted, the SDK's default OpenAI endpoint is used. |
| `models` | `{ tts: string; chat: string }` | `{ tts: "gpt-4o-mini-tts", chat: "gpt-4o-mini" }` | Default model per capability. Every request may override via its own `model` field. |
| `timeoutMs` | `number` | `60_000` | Per-request timeout, ms — enforced by the SDK client's own `timeout` option. A timeout surfaces as a retryable error. |
| `priceOverrides` | `Record<string, { inputPerM?: number; outputPerM?: number; ttsPerMChars?: number }>` | `{}` | USD price overrides by model, merged field-by-field over the bundled table. Required for custom/unlisted models — an unpriced model estimates as $0. |

### Environment variables

- **`OPENAI_API_KEY`** (or whatever `apiKeyEnv` names) — the API key. Read lazily through
  `ctx.env` on the first `execute()` call; `info()` and every `estimate()` work without it.
  When unset at execute time, the pinned two-line error is thrown:

  ```
  [ai] OPENAI_API_KEY is not set.
    Export it or set config.apiKeyEnv to the variable that holds your key.
  ```

### Account pools

M0 has no account pools: the plugin holds a single API key and the runner schedules its work on
the lane `"{task}/openai/default"` (the literal `"default"` account). Multi-account rotation is a
lane-level concern that arrives with pools — nothing in this plugin's config addresses it yet.

### Bundled price table

`prices.ts` ships USD prices per one million tokens / characters; `config.priceOverrides` merges
over it (computed once, cached in state):

| Model | Input /M tokens | Output /M tokens | TTS /M chars |
|-------|-----------------|------------------|--------------|
| `gpt-4o-mini` | $0.15 | $0.60 | — |
| `gpt-4o` | $2.50 | $10.00 | — |
| `gpt-4o-mini-tts` | — | — | $15 |
| `tts-1` | — | — | $15 |
| `tts-1-hd` | — | — | $30 |

Token counts for estimates use a `chars / 4` heuristic (`estimateTokenCount`) — a fast,
dependency-free approximation, not a real tokenizer.

## API reference

### `app.openai.info()`

```ts
info(): { provider: "openai"; configured: boolean; models: { tts: string; chat: string } };
```

Provider health/info snapshot — the plugin's only public API method. `configured` is
`ctx.env.get(config.apiKeyEnv) !== undefined`; the call never throws and never constructs the
SDK client.

```ts
app.openai.info();
// => { provider: "openai", configured: true, models: { tts: "gpt-4o-mini-tts", chat: "gpt-4o-mini" } }
```

### Registered handlers

Everything else the plugin does is exposed through the three handlers it registers with the
registry. Each implements its task's contract (`estimate` + `execute`) and is reached via that
task's facade or the runner — with `provider: "openai"`.

#### `("voiceover", "openai")` — `tts/handler.ts`, implements `VoiceoverHandler`

```ts
estimate(request: VoiceoverRequest): { usd: number };
execute(request: VoiceoverRequest, opts: { signal?: AbortSignal }): Promise<VoiceoverResult>;
```

- **estimate** — `text.length` characters x the model's `ttsPerMChars` price. Deterministic:
  OpenAI tts pricing is per character, so estimate and actual cost use the same formula.
- **execute** — calls `audio.speech.create` and returns `{ audio: Uint8Array, mimeType, costUsd,
  meta: { characters, model } }`. Model resolves from `request.model ?? config.models.tts`.
  Format mapping: `"wav"` → `wav` (`audio/wav`), `"ogg"` → `opus` (`audio/ogg`, OpenAI's closest
  container-compatible codec), omitted/`"mp3"` → `mp3` (`audio/mpeg`).
- **throws** — missing-key error, or a classified provider error (see below).

```ts
const result = await app.voiceover.generate(
  { text: "Hello!", voice: "alloy", format: "mp3" },
  { provider: "openai" }
);
// result.audio: Uint8Array, result.mimeType: "audio/mpeg", result.costUsd: number
```

#### `("translate", "openai")` — `translate/handler.ts`, implements `TranslateHandler`

```ts
estimate(request: TranslateRequest): { usd: number };
execute(request: TranslateRequest, opts: { signal?: AbortSignal }): Promise<TranslateResult>;
```

- **estimate** — `chars / 4` token heuristic for the system prompt + input text (input) and the
  source text again (output — translated output is assumed the same order of magnitude), priced
  at the chat model's per-million-token rates.
- **execute** — calls `chat.completions.create` with a fixed translation system prompt
  (`sourceLang` interpolated, or "auto-detect" when omitted; `targetLang` required) and
  `temperature: 0` (translation needs no creative sampling). Returns `{ text, costUsd, meta:
  { model, promptTokens, completionTokens } }`. Cost is usage-based when the provider reports
  `usage`, else falls back to the heuristic. `detectedSourceLang` is intentionally never set — a
  chat completion gives no reliable signal for it.
- **throws** — missing-key error, classified provider errors, `TerminalProviderError` when the
  response has no choices, `FlaggedProviderError` when the model returns a non-null `refusal`.

```ts
const result = await app.translate.generate(
  { text: "Hello, world!", targetLang: "es" },
  { provider: "openai" }
);
// result.text: "Hola, mundo!", result.costUsd from reported usage
```

#### `("prompt-gen", "openai")` — `prompt-gen/handler.ts`, implements `PromptGenHandler`

```ts
estimate(request: PromptGenRequest): { usd: number };
execute(request: PromptGenRequest, opts: { signal?: AbortSignal }): Promise<PromptGenResult>;
```

- **estimate** — same `chars / 4` heuristic over `prompt` + `system` (input) and `prompt` again
  (output), priced at chat rates.
- **execute** — calls `chat.completions.create` with the caller's `system` (when given),
  `prompt`, and `temperature` (forwarded only when given — the SDK default applies otherwise).
  Returns `{ text, costUsd, meta: { model, promptTokens, completionTokens } }`; usage-based cost
  with the same heuristic fallback.
- **throws** — same taxonomy as translate (missing key, classified errors, no-choices terminal,
  refusal → flagged).

```ts
const result = await app.promptGen.generate(
  { prompt: "Describe a sunset over the ocean.", temperature: 0.7 },
  { provider: "openai" }
);
```

## Events

None. The plugin emits nothing and listens to nothing — all communication is through the
registry (three `register` calls in `onInit`) and thrown/returned values. Diagnostics go through
`ctx.log` only: `openai:tts:done`, `openai:translate:done`, `openai:prompt-gen:done` on success
(model + token/character counts, never text) and `openai:tts:failed` /
`openai:translate:failed` / `openai:prompt-gen:failed` on failure (redacted error class +
status/kind only).

## Usage examples

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({
  pluginConfigs: {
    openai: {
      apiKeyEnv: "OPENAI_API_KEY",
      models: { tts: "gpt-4o-mini-tts", chat: "gpt-4o" },
      timeoutMs: 60_000,
      priceOverrides: {
        // Price a custom model so estimates and budget gates are non-zero.
        "gpt-4o-2024-11-20": { inputPerM: 2.5, outputPerM: 10 }
      }
    }
  }
});

await app.start();

// Provider health — safe with no API key configured.
const { configured } = app.openai.info();

// Pre-flight cost estimate — also key-free.
const { usd } = app.voiceover.estimate(
  { text: "Welcome to the show!", voice: "alloy" },
  { provider: "openai" }
);

// One-off generation through the task facades (registry-resolved).
const speech = await app.voiceover.generate(
  { text: "Welcome to the show!", voice: "alloy", format: "ogg" },
  { provider: "openai" }
);
const translated = await app.translate.generate(
  { text: "Welcome to the show!", targetLang: "ja" },
  { provider: "openai" }
);

await app.stop();
```

Cancelling an in-flight request:

```ts
const controller = new AbortController();
const pending = app.promptGen.generate(
  { prompt: "Write a haiku about build systems." },
  { provider: "openai", signal: controller.signal }
);
controller.abort(); // propagates to the SDK request; the abort error resurfaces unchanged
```

Using an OpenAI-compatible endpoint:

```ts
const app = createApp({
  pluginConfigs: {
    openai: {
      apiKeyEnv: "MY_PROXY_KEY",
      baseUrl: "https://my-proxy.example.com/v1",
      models: { tts: "gpt-4o-mini-tts", chat: "gpt-4o-mini" },
      timeoutMs: 60_000,
      priceOverrides: {}
    }
  }
});
```

## Integration

### Registration

`openai` depends on `registryPlugin` (mandatory-depends). In `onInit` it registers all three
handlers via `ctx.require(registryPlugin)`; nothing happens in `onStart`/`onStop` — the SDK
client is stateless HTTP over fetch, created lazily. After init, `"openai"` appears in
`app.voiceover.providers()`, `app.translate.providers()`, and `app.promptGen.providers()`
(registration order decides each task's implicit default provider — `elevenlabs` registers
before `openai` in the framework assembly, so `openai` is the voiceover fallback, not the
default).

### Lazy client

`getOpenaiClient` (`client.ts`) constructs the SDK client on the first `execute()` and caches it
in plugin state. `info()` and `estimate()` never touch it, so a keyless environment can still
inspect providers and price work. The client is a thin structurally-typed wrapper
(`OpenaiClient` in `types.ts`) covering exactly the two SDK calls the handlers make —
deliberately not the SDK's own namespace type, which `.d.ts` bundling drops.

### Error classification and retries

The SDK's internal retry loop is disabled (`maxRetries: 0`): retry timing, backoff, and jitter
are owned entirely by the `runner` (`src/plugins/runner/retry.ts`), so each provider failure
surfaces exactly once per attempt. `classifyOpenaiError` maps every caught SDK error onto three
error classes (defined in this plugin's `types.ts`), carrying the structural
`ProviderErrorHint` fields (`status` / `kind` / `retryAfterMs`) the runner's `classifyError`
reads:

| Failure | Thrown class | Hint fields | Runner outcome |
|---------|--------------|-------------|----------------|
| Request timeout | `RetryableProviderError` | `kind: "timeout"` | retried with backoff |
| Network / connection failure | `RetryableProviderError` | `kind: "network"` | retried with backoff |
| HTTP 429 rate limit | `RetryableProviderError` | `status: 429`, `retryAfterMs` | retried; `Retry-After` honored |
| HTTP 5xx | `RetryableProviderError` | `status` | retried with backoff |
| Other HTTP 4xx | `TerminalProviderError` | `status` | terminal `failed`, never retried |
| Content policy / refusal | `FlaggedProviderError` | `kind: "content-policy"` | terminal `flagged`, never re-queued |

Content policy is detected two ways: an SDK error whose body carries a
`content_policy` / `content_filter` / `moderation` marker, or (chat handlers) a successful
response whose message has a non-null `refusal`. Every thrown message is a fixed, redacted
string — the caught SDK error's own message (which may embed request/response text) is never
echoed.

### Retry-After handling

On a 429, `retryAfterMsFromHeaders` reads the `Retry-After` response header in both forms — a
delay in seconds, or an HTTP-date converted to a delay from now (proxies behind `baseUrl` may
emit either) — and attaches it as `retryAfterMs`. The runner's `backoffMs` uses it whenever it
exceeds the computed jittered backoff, so the provider's own pacing wins over blind exponential
retry.

### Abort / clean pause

Every `execute()` forwards `opts.signal` to the SDK per request. A caller-initiated abort is the
runner's deliberate clean pause, not a provider failure, and is kept out of the taxonomy on two
paths: the SDK's `APIUserAbortError` is returned unchanged by `classifyOpenaiError`, and the
request boundary rethrows the original error whenever `signal.aborted` is already true. Either
way the abort never classifies as retryable — which would penalize the circuit breaker and burn
a retry attempt.

### Rate-limit interplay with `limits`

The plugin never talks to `limits` directly. The runner acquires lane capacity
(`limits.acquire("{task}/openai/default")`) before dispatching, then reports each outcome back:
a `RetryableProviderError` (including 429s) is reported as `"retryable-error"`, feeding the
lane's circuit breaker so a struggling provider is throttled across the whole run; successes
report `"ok"`. Accurate classification in this plugin is therefore what keeps openai's lane
health signal honest.

## File layout

```
openai/
├── index.ts             # createPlugin: depends [registry], onInit registers 3 handlers
├── types.ts             # Config/State/OpenaiClient/request-response shapes + error classes
├── state.ts             # { client: null, prices: null } — both lazily created
├── api.ts               # app.openai.info()
├── client.ts            # lazy SDK factory, call options, error classification, redaction
├── prices.ts            # bundled price table + shared estimate math
├── tts/handler.ts       # VoiceoverHandler ("voiceover", "openai")
├── translate/handler.ts # TranslateHandler ("translate", "openai")
├── prompt-gen/handler.ts# PromptGenHandler ("prompt-gen", "openai")
└── __tests__/           # unit + integration (mocked SDK boundary, no network)
```
