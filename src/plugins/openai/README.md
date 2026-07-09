# openai

> Complex plugin — OpenAI provider via the official SDK: voiceover (tts) + translate + prompt-gen submodules

Owns all OpenAI capabilities via the official `openai` SDK (fetch-based, no axios). Registers
THREE handlers in `onInit`: `("voiceover", "openai")` (tts submodule), `("translate", "openai")`
(chat-based, translate submodule), `("prompt-gen", "openai")` (chat-based, prompt-gen submodule).
Submodules never import each other — shared client + prices live at the plugin root (`client.ts`,
`prices.ts`) and each submodule imports from there.

## Config

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `apiKeyEnv` | `string` | `"OPENAI_API_KEY"` | Env var name holding the API key — resolved via `ctx.env` at request time. |
| `baseUrl` | `string?` | `undefined` | Optional API base URL override (proxies / OpenAI-compatible endpoints). |
| `models` | `{ tts: string; chat: string }` | `{ tts: "gpt-4o-mini-tts", chat: "gpt-4o-mini" }` | Default models per capability. |
| `timeoutMs` | `number` | `60_000` | Request timeout, ms (enforced by the SDK client's own `timeout` option). |
| `priceOverrides` | `Record<string, { inputPerM?; outputPerM?; ttsPerMChars? }>` | `{}` | Price overrides by model, merged over the bundled table. |

## The SDK client

The SDK client is **lazy**: it is never constructed at `onInit`, only on the first `execute()`
call (`client.ts` `getOpenaiClient`). `app.openai.info()` and every handler's `estimate()` work
with no API key configured at all — only `execute()` needs one. When `config.apiKeyEnv` is unset
at that point, execution throws:

```
[ai] OPENAI_API_KEY is not set.
  Export it or set config.apiKeyEnv to the variable that holds your key.
```

The SDK's own internal retry loop is disabled (`maxRetries: 0`) — retry timing/backoff/jitter is
owned entirely by `runner` (`src/plugins/runner/retry.ts`), so a provider failure is surfaced
exactly once per attempt instead of being silently retried twice.

## Error classification

Every handler maps caught SDK errors onto three error classes (`types.ts`), each carrying the
runner's `ProviderErrorHint` fields (`status`/`kind`/`retryAfterMs`) so
`src/plugins/runner/retry.ts` `classifyError` lands each throw in the right taxonomy row:

| Failure | Error class | Hint fields |
|---------|-------------|-------------|
| Timeout | `RetryableProviderError` | `kind: "timeout"` |
| Network / connection failure | `RetryableProviderError` | `kind: "network"` |
| 429 rate limit | `RetryableProviderError` | `status: 429`, `retryAfterMs` (from the `Retry-After` header) |
| 5xx server error | `RetryableProviderError` | `status` |
| Other 4xx | `TerminalProviderError` | `status` |
| Content-policy rejection/refusal | `FlaggedProviderError` | `kind: "content-policy"` |

Content-policy failures are detected two ways: an SDK-thrown error whose body carries a
`content_policy`/`content_filter`/`moderation` marker, or (for the chat-based handlers) a
successful response whose message carries a non-null `refusal`. Neither path ever echoes the
caught error's message or the request/response text — every thrown message is a fixed, redacted
string; `meta` on a successful result carries only token counts and the model name.

## Submodules

### `tts/handler.ts` — voiceover

`estimate` prices `text.length` characters against the tts per-million-characters price.
`execute` calls `audio.speech.create` (voice/model/format mapped from the request; `"ogg"` maps to
OpenAI's `"opus"` codec, the closest equivalent) and returns the raw audio bytes, MIME type, and
actual cost (identical formula to the estimate — OpenAI's tts pricing is deterministic per
character).

### `translate/handler.ts` — translate

`estimate` uses a `chars / 4` token-count heuristic (English-text approximation, not a real
tokenizer) for both the prompt and the expected translated output, priced against the chat model's
per-million-token prices. `execute` calls `chat.completions.create` with a fixed translation
system prompt (source/target language interpolated) and `temperature: 0`, returning usage-based
actual cost when the provider reports `usage`, else falling back to the same heuristic.
`detectedSourceLang` is intentionally never set — a chat completion gives no reliable signal to
derive it from without a separate prompt/turn.

### `prompt-gen/handler.ts` — prompt-gen

Same `chars / 4` heuristic for `estimate`. `execute` calls `chat.completions.create` with the
caller's `system`/`prompt`/`temperature`, returning usage-based actual cost (or the heuristic
fallback when `usage` is absent).

## API

### `info(): { provider: "openai"; configured: boolean; models: { tts, chat } }`

Provider health/info. `configured` is `ctx.env.get(config.apiKeyEnv) !== undefined` — never
throws, never constructs the SDK client.

## Events

None.

## Dependencies

- `registryPlugin` — registers all three handlers in `onInit` via `ctx.require(registryPlugin)`.

## Usage

```typescript
const app = createApp({
  pluginConfigs: {
    openai: { apiKeyEnv: "OPENAI_API_KEY", models: { tts: "gpt-4o-mini-tts", chat: "gpt-4o-mini" } }
  }
});

app.openai.info(); // => { provider: "openai", configured: true, models: {...} }

// Via the task facades (resolved through the registry):
await app.voiceover.generate({ text: "Hello!", voice: "alloy" }, { provider: "openai" });
await app.translate.generate({ text: "Hello!", targetLang: "es" }, { provider: "openai" });
await app.promptGen.generate({ prompt: "Describe a sunset." }, { provider: "openai" });
```
