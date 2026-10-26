# anthropic

> Anthropic provider adapter — prompt-gen over the Messages API with the official `@anthropic-ai/sdk`.

## Purpose

`anthropic` is a provider plugin. It defines no task of its own: it implements the task-owned
`PromptGenHandler` contract (`src/plugins/promptGen/contract.ts`) and registers it as
`("prompt-gen", "anthropic")` in `onInit`. `app.promptGen.generate` and the `runner` reach it through
the `registry`.

It reads the same request contract as fal's prompt-gen (`messages`, `tools`, `toolChoice`,
`cacheSystem`, part `cache: true`, and `params.reasoning`, `params.max_tokens`,
`params.responseSchema`, `params.images`). A consumer moves a call from fal to Anthropic by the
provider and model name only.

Every request is streamed (`messages.stream(...).finalMessage()`), so a 128K `max_tokens` works. The
SDK's own retries are off: the runner owns retries. Prompts, answers and the key never appear in
errors, logs or result metadata.

## Configuration

Under the `anthropic` key of `pluginConfigs`:

```ts
createApp({ pluginConfigs: { anthropic: { model: "claude-sonnet-5-5", maxTokens: 64_000 } } });
```

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKeyEnv` | `string` | `"ANTHROPIC_API_KEY"` | Env var with the API key, read through `ctx.env` on the first `execute`. |
| `baseUrl` | `string` (optional) | SDK default | API base URL override. |
| `model` | `string` | `"claude-opus-5-5"` | Model when the request names none, or names `"default"`. Aliases work here too. |
| `maxTokens` | `number` | `32_000` | Output cap when `params.max_tokens` is not a positive integer. |
| `timeoutMs` | `number` | `900_000` | Request timeout, ms. A timeout is retryable. |
| `priceOverrides` | `Record<string, Partial<AnthropicPrice>>` | `{}` | Per-model prices, merged field by field over the bundled table. |

### Environment variable

- **`ANTHROPIC_API_KEY`** (or the name in `apiKeyEnv`). `info()` and `estimate()` never need it.
  When it is unset, `execute` throws `PromptGenUnavailableError` with reason `"auth"`, so
  `promptGen` moves to the next provider of its `fallback` chain. No request is sent.

  ```
  [ai] ANTHROPIC_API_KEY is not set.
    Export it, or use another prompt-gen provider.
  ```

## Models and prices

USD per 1M tokens (`prices.ts`). Cache writes are priced per lifetime.

| Model | Input | Output | Cache read | Cache write 5m | Cache write 1h | Long context |
|---|---|---|---|---|---|---|
| `claude-opus-5-5` | 4 | 20 | 0.20 | 5 | 8 | — |
| `claude-sonnet-5-5` | 2 | 10 | 0.20 | 2.50 | 4 | — |
| `claude-sonnet-5` | 2 | 10 | 0.20 | 2.50 | 4 | — |
| `claude-haiku-5-5` | 0.10 | 0.50 | 0.01 | 0.125 | 0.20 | above 100 000 input: ×5 in, ×5 out |
| `claude-fable-5-1` | 10 | 50 | 0.25 | 12.50 | 20 | — |

Aliases (`models.ts`), the fal/OpenRouter ids the studio uses today:

| Alias | Native id |
|---|---|
| `anthropic/claude-opus-5.5` | `claude-opus-5-5` |
| `anthropic/claude-sonnet-5.5` | `claude-sonnet-5-5` |
| `anthropic/claude-sonnet-5` | `claude-sonnet-5` |
| `anthropic/claude-haiku-5.5` | `claude-haiku-5-5` |
| `anthropic/claude-fable-5.1` | `claude-fable-5-1` |

Any other id is sent as is. It needs a complete price (all five rates) in `priceOverrides`,
otherwise the request is refused with a terminal 400 before any I/O:

```ts
createApp({
  pluginConfigs: {
    anthropic: {
      priceOverrides: {
        "claude-next-6": { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWrite5mPerM: 6.25, cacheWrite1hPerM: 10 }
      }
    }
  }
});
```

### Cost

- Actual cost, from the answer's usage: uncached input × input + 5m writes × write 5m + 1h writes ×
  write 1h + cache reads × read + output × output. Without the lifetime breakdown, every write is
  priced at 5m.
- Long context: when the total input (uncached + writes + reads) passes the threshold, every
  input-side rate × the input multiplier and output × the output multiplier, for the whole request.
- Rounded to micro-dollars.
- `estimate` is offline: characters / 4 of the system text and the prompt (or every message text and
  tool-call JSON), plus 1 600 tokens per image, in; `max_tokens` out; same price rule.

## Request parameters

| Request field | Messages API | Notes |
|---|---|---|
| `system` | `system: string` | With `cacheSystem`: one text block with `cache_control`. |
| `prompt` (no `messages`) | one user message | With `params.images`: the image blocks first, then the text. |
| `messages` | user / assistant turns | `prompt` is ignored. |
| `tools` | `{ name, description, input_schema }` | Sent only when there is at least one tool. |
| `toolChoice` | auto → `auto`, none → `none`, required → `any`, `{ name }` → `tool` | Opus 5.5, Sonnet 5.5 and Fable 5.1 answer a forced choice with a terminal 400. |
| `params.reasoning` | `output_config.effort` | off → low, low → low, medium → medium, high → high; unset → medium; other → 400. No `thinking` field. |
| `params.responseSchema` | `output_config.format: { type: "json_schema", schema }` | Normalized by the SDK's `transformJSONSchema`; a schema it cannot read (no `type`) is sent as given. Not a plain object → 400. `params.strictSchema` is not read. |
| `params.max_tokens` | `max_tokens` | Positive integer, else `config.maxTokens`. |
| `params.images` | base64 image blocks | One `{ path, mimeType, hash }` or a list. Refused with `messages` (images go in parts). jpeg, png, gif and webp only. |
| `temperature` | never sent | Current models reject it. |

Requests refused with a terminal 400 before any I/O: empty `messages`, an empty prompt without
`messages`, a model without a price, a bad `params.reasoning` or `params.responseSchema`,
`params.images` with `messages`, an image that is not a local file, an image type the API cannot
read.

## Prompt cache

- Marks: `cacheSystem` on the system text, and every text part with `cache: true` (user and tool
  messages). Each becomes `cache_control: { type: "ephemeral" }` (5 minutes).
- The API takes at most 4 marks. The first 4 in request order keep `cache_control`; the rest are sent
  without it.
- `usage.cachedTokens` / `cachedReadTokens` are the cache reads, `cacheWriteTokens` /
  `cachedWriteTokens` the writes. `promptTokens` is every input token: uncached, written and read.

## Tools and thinking

- A `tool_use` block of the answer becomes a `ToolCall` (`finishReason: "tool_calls"`).
- Consecutive `tool` messages are sent as one user message of `tool_result` blocks; a tool result
  may carry text and image parts.
- Thinking blocks must go back unchanged with their tool turn. The prompt-gen `ChatMessage` cannot
  carry them, so the plugin keeps the whole content of every answer with tool calls in
  `state.turns`, keyed by its first tool_use id. An assistant turn whose first tool call id is
  there is sent with those blocks, thinking included. Otherwise it is rebuilt from its text and
  `tool_use` blocks.
- The memory holds the last 500 turns. It is lost on a restart: a resumed loop then sends the open
  tool turn without its thinking, and the API may answer it with a terminal 400.

## Answers

| `stop_reason` | `finishReason` |
|---|---|
| `end_turn`, `stop_sequence` | `stop` |
| `tool_use` | `tool_calls` |
| `max_tokens` | `length` (logged `anthropic:prompt-gen:partial`) |
| `refusal` | throws `FlaggedProviderError` |
| anything else | `other` |

`text` is the text blocks joined with `""`. `meta` is `{ model, effort, stopReason, promptTokens,
completionTokens }` and never carries text.

## Errors

| SDK error | Thrown |
|---|---|
| `APIUserAbortError`, or any failure after the caller aborted | rethrown unchanged |
| `APIConnectionTimeoutError` | `RetryableProviderError { kind: "timeout" }` |
| `RateLimitError` (429) | `RetryableProviderError { status: 429, retryAfterMs? }` (from `retry-after`) |
| `APIError` with status ≥ 500 (529 overloaded included) | `RetryableProviderError { status }` |
| any other `APIError` with a status | `TerminalProviderError(status)` |
| anything else (connection error, stream error) | `RetryableProviderError { kind: "network" }` |

Messages are fixed `[ai] Anthropic …` strings, never the SDK's message. A 401, 402, 403 or 429 also
makes `promptGen` fall back to the next provider (`isPromptGenUnavailable`). The error classes ship
as `AnthropicErrors` from the package root.

## Logs

| Event | Level | Fields |
|---|---|---|
| `anthropic:prompt-gen:done` | info | `model`, `promptTokens`, `completionTokens`, `cachedTokens` |
| `anthropic:prompt-gen:partial` | warn | `model` |
| `anthropic:prompt-gen:failed` | warn | `errorType`, `status?`, `kind?` |

## API reference

### `app.anthropic.info()`

Whether the key is set (never throws, never builds the client) and the default model.

```ts
app.anthropic.info(); // { provider: "anthropic", configured: true, model: "claude-opus-5-5" }
```

## Usage

```ts
const result = await app.promptGen.generate(
  {
    prompt: "Judge these frames.",
    system: BIBLE,
    cacheSystem: true,
    params: { reasoning: "medium", max_tokens: 128_000, responseSchema: schema, images: [sheet] }
  },
  { provider: "anthropic" }
);
```

## Files

| File | What |
|---|---|
| `index.ts` | Wiring: config, state, API, the `onInit` registration. |
| `types.ts` | Config, prices, the structural `AnthropicClient` and its request/answer types, state, API. |
| `errors.ts` | `RetryableProviderError`, `TerminalProviderError`, `FlaggedProviderError`. |
| `client.ts` | Lazy SDK client, missing key, the 400 of a refused request, error table, redaction. |
| `prices.ts` | Bundled table, override merge, cost. |
| `models.ts` | Aliases, default model. |
| `images.ts` | Image checks and base64 blocks from disk. |
| `state.ts` | State factory and the turn memory. |
| `prompt-gen/request.ts` | Plan (every 400) and the Messages body. |
| `prompt-gen/answer.ts` | Text, tool calls, finish reason, usage. |
| `prompt-gen/handler.ts` | `estimate` and `execute`. |

## Testing

- Unit (`__tests__/unit/`): a fake structural client records each request body. One test per row
  of the mapping, error and cost tables; turn memory and its cap; estimate offline; missing key;
  redaction.
- Integration (`__tests__/integration/`): a real app with registry, promptGen and anthropic, the
  real SDK, and `fetch` stubbed with server-sent events. A prompt with a schema, an image and
  reasoning; a two-step `runToolLoop` that sends the thinking blocks back unchanged; the fallback to
  another provider without the key. No real network.
