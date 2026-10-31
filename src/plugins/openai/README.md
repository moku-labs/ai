# openai

> OpenAI provider adapter — one plugin, three capabilities: voiceover (tts), translate, and prompt-gen via the official `openai` SDK.

## Purpose

`openai` is a provider plugin: it owns every OpenAI capability in the build system through the
official fetch-based `openai` SDK (v5+, no axios). It does not define any task of its own —
instead it implements the task-owned contracts of three task plugins and registers a handler for
each in `onInit`: `("voiceover", "openai")` from the tts submodule, `("translate", "openai")` over
Chat Completions, and `("prompt-gen", "openai")` over the Responses API (GPT-6 tool calling
requires Responses). Task facades (`app.voiceover`,
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
| `timeoutMs` | `number` | `60_000` | Request timeout for tts and translate, ms — the SDK client's own `timeout` option. A timeout surfaces as a retryable error. |
| `promptGenTimeoutMs` | `number` | `900_000` | Request timeout for prompt-gen, ms, passed on each `responses.create` call: reasoning calls run for minutes. |
| `priceOverrides` | `Record<string, { inputPerM?, cachedInputPerM?, cacheWritePerM?, cacheWrite12hPerM?, outputPerM?, ttsPerMChars? }>` | `{}` | USD price overrides by model, merged field-by-field over the bundled table. Required for custom/unlisted models — an unpriced model costs $0 (prompt-gen logs `openai:prompt-gen:unpriced` once per model). |

### Environment variables

- **`OPENAI_API_KEY`** (or whatever `apiKeyEnv` names) — the API key. Read lazily through
  `ctx.env` on the first `execute()` call; `info()` and every `estimate()` work without it.
  When unset at execute time, the pinned two-line error is thrown:

  ```
  [ai] OPENAI_API_KEY is not set.
    Export it or set config.apiKeyEnv to the variable that holds your key.
  ```

  prompt-gen `execute` throws `PromptGenUnavailableError` with reason `"auth"` instead, so a
  `promptGen` fallback chain moves on (for example to `fal`):

  ```
  [ai] OPENAI_API_KEY is not set.
    Export it, or use another prompt-gen provider.
  ```

### Account pools

M0 has no account pools: the plugin holds a single API key and the runner schedules its work on
the lane `"{task}/openai/default"` (the literal `"default"` account). Multi-account rotation is a
lane-level concern that arrives with pools — nothing in this plugin's config addresses it yet.

### Bundled price table

`prices.ts` ships USD prices per one million tokens / characters; `config.priceOverrides` merges
over it (computed once, cached in state):

| Model | Input /M | Cached input /M | Cache write 30m /M | Cache write 12h /M | Output /M | TTS /M chars |
|-------|----------|-----------------|--------------------|--------------------|-----------|--------------|
| `gpt-6-astra` | $10 | $1 | $12.50 | $25 | $50 | — |
| `gpt-6.1-sol` | $2 | $0.10 | $2.50 | $5 | $10 | — |
| `gpt-6-sol` | $2 | $0.20 | $2.50 | $5 | $10 | — |
| `gpt-6-luna` | $0.10 | $0.01 | $0.125 | $0.25 | $0.50 | — |
| `gpt-4o-mini` | $0.15 | $0.075 | — | — | $0.60 | — |
| `gpt-4o` | $2.50 | $1.25 | — | — | $10.00 | — |
| `gpt-4o-mini-tts` | — | — | — | — | — | $15 |
| `tts-1` | — | — | — | — | — | $15 |
| `tts-1-hd` | — | — | — | — | — | $30 |

- **Long context:** a GPT-6 request above 272K input tokens pays every input-side rate ×2 and
  the output rate ×1.5.
- **Missing cache rates** fall back to the next rate up: cached input → input, 30m write → input,
  12h write → 30m write.
- Token counts for estimates use a `chars / 4` heuristic (`estimateTokenCount`) — a fast,
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

Calls the **Responses API** (`responses.create`) with `store: false` and
`timeout: config.promptGenTimeoutMs`. It reads the same request contract as fal's prompt-gen, so
the studio switches provider by name only.

**Models** (`prompt-gen/models.ts`). `model` defaults to `config.models.chat`; an `openai/<id>`
alias is sent as `<id>`.

| Model | Kind | `params.reasoning: "off"` sends | `temperature` |
|-------|------|----------------------------------|---------------|
| `gpt-6-astra`, `gpt-6.1-sol` | GPT-6 reasoning | effort `low` (`none` is a 400 there) | never sent |
| `gpt-6-sol`, `gpt-6-luna` | GPT-6 reasoning | effort `none` | never sent |
| any other (gpt-4o family) | chat | no `reasoning` field | forwarded when set |

**Params** (every other param is ignored):

| Param | Type | Default | Sent as |
|-------|------|---------|---------|
| `params.reasoning` | `"off" \| "low" \| "medium" \| "high"` | `"medium"` | `reasoning.effort` + `include: ["reasoning.encrypted_content"]` (GPT-6 only) |
| `params.max_tokens` | positive integer | `32_000` | `max_output_tokens` |
| `params.responseSchema` | JSON schema object | none | `text.format: { type: "json_schema", name: "answer", schema, strict }` |
| `params.strictSchema` | `boolean` | `false` | `strict` of the format above |
| `params.images` | `{ path, mimeType, hash }` or a list | none | `input_image` base64 data URLs after the prompt text |

**Request mapping** (`prompt-gen/request.ts`):

- `system` → a developer message (`input_text`). `cacheSystem` adds
  `prompt_cache_breakpoint: { mode: "explicit" }` on GPT-6 models.
- A text part with `cache: true` gets the same breakpoint on GPT-6 (ignored on gpt-4o models).
  More than 4 marks in one request: the first 4 in request order are kept, the system first.
- `cacheTtl` is ignored on openai.
- `prompt` → a user message; with `messages` the prompt is ignored and the turns are sent:
  user parts, assistant text, `function_call { call_id, name, arguments }` (without ids), and
  `function_call_output { call_id, output }` with a string or `input_text` / `input_image` parts.
  Image parts are read from disk as data URLs.
- **Reasoning replay:** the reasoning items of a tool-call answer are kept in plugin state under
  the answer's first call id (at most 500 turns, oldest dropped) and sent back before that turn's
  assistant text and function calls, in the order the model produced them. After a restart they
  are gone and the turn is sent without them, which OpenAI accepts.
- `tools` → `{ type: "function", name, description, parameters, strict: false }`; `toolChoice` →
  `"auto"` / `"none"` / `"required"` / `{ type: "function", name }`.
- Refused before any I/O with a terminal 400: an empty prompt or empty `messages`, a bad
  `params.reasoning`, a `responseSchema` that is not an object, `params.images` with `messages`, an
  image that is not `{ path, mimeType, hash }`.

**Answer** (`prompt-gen/answer.ts`):

| Answer | Result |
|--------|--------|
| `output_text` parts of the messages | `text`, joined |
| `function_call` items | `toolCalls` (`arguments` not JSON → `ToolArgumentsError`) |
| function calls present | `finishReason: "tool_calls"` |
| `incomplete` + `max_output_tokens` | `finishReason: "length"` |
| `completed` | `finishReason: "stop"`; anything else `"other"` |
| a `refusal` part, or `incomplete` + `content_filter` | `FlaggedProviderError` |
| `failed` | `TerminalProviderError` with the error code |

**Usage and cost.** `usage.promptTokens` is `input_tokens` (all input), `cachedReadTokens` is
`input_tokens_details.cached_tokens`, `cachedWriteTokens` is `.cache_write_tokens`, each set only
when reported. Cost = uncached input × input + cache reads × cached input + 30m writes × write 30m
+ 12h writes × write 12h + output × output, with the long-context tier above. Writes split by
`cache_write_tokens_details.ttl_30m_tokens` / `ttl_12h_tokens`; without a breakdown every write is
a 30m write. No usage in the answer: chars/4 of what was sent and received.

**Estimate** — offline, no key: chars/4 of all input text plus 1 600 tokens per image in,
`max_output_tokens` out, at the model's price (an upper bound).

**Errors** — a missing key is `PromptGenUnavailableError` (`"auth"`, see above); SDK errors use
the classification table below.

```ts
const result = await app.promptGen.generate(
  { prompt: "Describe a sunset over the ocean.", temperature: 0.7 },
  { provider: "openai" }
);

// GPT-6 Astra with a schema and a frame to check.
const review = await app.promptGen.generate(
  {
    prompt: "Is the subject in frame?",
    model: "gpt-6-astra",
    params: {
      reasoning: "high",
      responseSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      images: [{ path: "frames/s3-012.png", mimeType: "image/png", hash: "9f2c1a" }]
    }
  },
  { provider: "openai" }
);
```

## Events

None. The plugin emits nothing and listens to nothing — all communication is through the
registry (three `register` calls in `onInit`) and thrown/returned values. Diagnostics go through
`ctx.log` only: `openai:tts:done`, `openai:translate:done`, `openai:prompt-gen:done` on success
(model + token/character counts, never text) and `openai:tts:failed` /
`openai:translate:failed` / `openai:prompt-gen:failed` on failure (redacted error class +
status/kind only), and `openai:prompt-gen:unpriced` (model only) once per model without a price.

## Usage examples

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({
  pluginConfigs: {
    openai: {
      apiKeyEnv: "OPENAI_API_KEY",
      models: { tts: "gpt-4o-mini-tts", chat: "gpt-4o" },
      timeoutMs: 60_000,
      promptGenTimeoutMs: 900_000,
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
      // prompt-gen calls /v1/responses: the proxy must serve it, not only /v1/chat/completions.
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
(`OpenaiClient` in `types.ts`) covering exactly the three SDK calls the handlers make
(`audio.speech.create`, `chat.completions.create`, `responses.create`) —
deliberately not the SDK's own namespace type, which `.d.ts` bundling drops.

### Error classification and retries

The SDK's internal retry loop is disabled (`maxRetries: 0`): retry timing, backoff, and jitter
are owned entirely by the `runner` (`src/plugins/runner/retry.ts`), so each provider failure
surfaces exactly once per attempt. `classifyOpenaiError` maps every caught SDK error onto three
error classes (defined in this plugin's `errors.ts`), carrying the structural
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
| prompt-gen `execute` without an API key | `PromptGenUnavailableError` | `reason: "auth"` | promptGen falls back to the next provider |
| prompt-gen answer `failed` | `TerminalProviderError` | — | terminal `failed`, never retried |

Content policy is detected two ways: an SDK error whose body carries a
`content_policy` / `content_filter` / `moderation` marker, or a successful answer that refuses:
a non-null `refusal` (translate), a `refusal` part or `incomplete` + `content_filter`
(prompt-gen). Every thrown message is a fixed, redacted
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
├── types.ts             # Config/State/OpenaiClient/request-response shapes (error classes re-exported as types)
├── errors.ts            # RetryableProviderError / TerminalProviderError / FlaggedProviderError (runtime values)
├── state.ts             # { client: null, prices: null, turns: Map } — client and prices lazy
├── api.ts               # app.openai.info()
├── client.ts            # lazy SDK factory, call options, error classification, redaction
├── prices.ts            # bundled price table + chat, tts and cache-aware cost math
├── images.ts            # local image files as base64 data URLs
├── tts/handler.ts       # VoiceoverHandler ("voiceover", "openai")
├── translate/handler.ts # TranslateHandler ("translate", "openai"), Chat Completions
├── prompt-gen/
│   ├── handler.ts       # PromptGenHandler ("prompt-gen", "openai"), Responses API
│   ├── models.ts        # model ids, GPT-6 family, effort map, long-context tier
│   ├── request.ts       # checks before I/O + the Responses request body
│   └── answer.ts        # answer reading, usage, cost, tool-turn memory
└── __tests__/           # unit + integration (mocked SDK boundary, no network)
```
