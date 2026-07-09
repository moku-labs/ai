# elevenlabs

> Complex plugin — ElevenLabs provider: owns all ElevenLabs capabilities (M0: voiceover via a thin fetch client)

The `elevenlabs` plugin owns everything ElevenLabs-specific: a thin internal `fetch` client (no
SDK dependency — one TTS endpoint doesn't justify one), a bundled price table, and per-task
handler submodules. At M0 it implements one capability, `("voiceover", "elevenlabs")`, registered
with the [`registry`](../registry) plugin in `onInit`.

Per-task submodules (currently just `voiceover/`) never import each other — they coordinate
through this plugin's root `state` (the shared, lazily-computed price table).

## API

`app.elevenlabs.*` is a thin observability surface. The real capability surface is the
`VoiceoverHandler` registered with `registry` — consume it through `app.voiceover` (the task
facade) or `app.runner` (the durable pipeline), not directly.

```ts
app.elevenlabs.info();
// => { provider: "elevenlabs", configured: true, models: ["eleven_multilingual_v2", ...] }
```

| Method | Returns | Description |
| --- | --- | --- |
| `info()` | `{ provider: "elevenlabs"; configured: boolean; models: string[] }` | Whether an API key is present (`ctx.env.has`, never throws) and the models known to the effective price table. |

## Configuration

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKeyEnv` | `string` | `"ELEVENLABS_API_KEY"` | Env var name holding the API key. Resolved via `ctx.env` at request time — never stored. |
| `baseUrl` | `string` | `"https://api.elevenlabs.io"` | API base URL. |
| `defaultModel` | `string` | `"eleven_multilingual_v2"` | Model used when a request doesn't name one. |
| `timeoutMs` | `number` | `60_000` | Request timeout, ms. |
| `priceOverrides` | `Record<string, number>` | `{}` | Per-model USD-per-character overrides, merged over the bundled table. |

```ts
createApp({
  pluginConfigs: {
    elevenlabs: {
      apiKeyEnv: "MY_ELEVENLABS_KEY",
      priceOverrides: { eleven_multilingual_v2: 0.00025 }
    }
  }
});
```

## Voiceover handler

`voiceover/handler.ts` implements `VoiceoverHandler` (`../voiceover/contract.ts`):

- `estimate(request)` — characters × price-per-char for the resolved model. Never touches the network.
- `execute(request, { signal })` — resolves the API key via `ctx.env.require`-equivalent (a
  missing key throws before any network call), POSTs to `/v1/text-to-speech/{voiceId}` with the
  resolved model/format mapped into the URL + body, and forwards `signal` to `fetch` so an
  external abort cancels the in-flight request cleanly.

### Error taxonomy

`execute()` classifies every failure into one of three Error subclasses, each carrying the
structural fields the runner's `classifyError` (`../runner/retry.ts`) reads by shape alone
(`status`/`kind`/`retryAfterMs`) — no cross-plugin error-class import:

| Failure | Error class | Structural fields |
| --- | --- | --- |
| HTTP 5xx | `RetryableProviderError` | `status: <code>` |
| HTTP 429 | `RetryableProviderError` | `status: 429`, `retryAfterMs` (from `Retry-After`) |
| Request timeout | `RetryableProviderError` | `kind: "timeout"` |
| Network failure | `RetryableProviderError` | `kind: "network"` |
| Other HTTP 4xx | `TerminalProviderError` | `status: <code>` |
| Content-policy rejection | `FlaggedProviderError` | `kind: "content-policy"` |

Thrown messages and `ctx.log` calls never echo request text or response bodies — only status
codes and error classes (the redaction rule).

### Missing API key

When `config.apiKeyEnv` resolves to nothing, `execute()` throws before any network call:

```
[ai] ELEVENLABS_API_KEY is not set.
  Export it or set config.apiKeyEnv to the variable that holds your key.
```

## Dependencies

- [`registry`](../registry) — the handler is registered under `("voiceover", "elevenlabs")` in `onInit`.

## Lifecycle

`onInit` only — registration is a synchronous map insertion, and the fetch client is stateless,
so there's no `onStart`/`onStop` resource to manage.
