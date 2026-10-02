# claude

> Text provider over the local Claude Code CLI (`claude -p --output-format json`). Complex tier. Registers `("prompt-gen", "claude")` with the registry in `onInit`. No events, no state.

## Purpose

Claude Code runs on the user's Claude plan, so the marginal price of one answer is $0. `costUsd` is always `0`.
The CLI's own list-price figure (`total_cost_usd`) is kept in `meta.listCostUsd` for reference.

Each call owns one temp dir, `moku-claude-*`, under `workDir` (or `os.tmpdir()` when `workDir` is `""`):

1. `params.images` are copied in as `image-1.png`, `image-2.jpg`, ... Store paths have no extension, and the Read tool needs one.
2. `claude -p` runs with the dir as cwd. The dir is outside the repo, so no project `CLAUDE.md` is loaded.
3. The prompt goes to stdin, then stdin is closed. stdout is the JSON result.
4. The dir is removed in `finally`, on success and on every failure.

## Configuration

Set via `createApp({ pluginConfigs: { claude: { ... } } })`.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `bin` | `string` | `"claude"` | Executable. A bare name is looked up on PATH. |
| `textModel` | `string` | `""` | Model when mapping gives none. `""` = no `--model`, the CLI's default. |
| `modelMap` | `Record<string, string>` | `{}` | Exact request-model id to claude model. Checked before the built-in mapping. |
| `timeoutMs` | `number` | `600_000` | Kill the CLI (SIGTERM) after this long. |
| `workDir` | `string` | `""` | Root for per-call temp dirs. `""` = `os.tmpdir()`. |

## Command

```
claude -p --output-format json --no-session-persistence
  --setting-sources user --strict-mcp-config --disable-slash-commands
  --system-prompt <request.system or the default>
  --restricted --tools Read --allowedTools Read --permission-prompts none    (with images)
  --tools ""                                                    (without images)
  [--model <mapped>] [--effort <low|medium|high>] [--json-schema <schema>]
```

- The default system prompt is `Answer the request directly. Output only the answer.` It replaces Claude Code's coding-agent prompt.
- No `--bare`: it disables OAuth, so plan billing breaks.
- `--json-schema` carries `params.responseSchema` as compact JSON, without a top-level `$schema`. The CLI rejects
  that key. It accepts `propertyNames`, record maps and optional keys (checked live with 2.1.280). The schema is
  not in the prompt.
- The flag takes only a root `type: "object"`. Any other root, an array for example, goes in the prompt instead,
  with the answer rule. The zod check is the same.

## Params

| Param | Shape | Effect |
| --- | --- | --- |
| `params.images` | `ImageFile` or `ImageFile[]` | Copied into the call dir. The prompt lists them by relative path, to be read with the Read tool. |
| `params.responseSchema` | plain JSON-schema object | Passed as `--json-schema` when the root is `type: "object"`, else put in the prompt. The answer is `structured_output`. Without it, `result` is parsed with one ```` ```json ```` fence stripped. Either is checked with `z.fromJSONSchema(schema)`. `text` is the validated JSON, re-stringified. |
| `params.reasoning` | `"off" \| "low" \| "medium" \| "high"` | `--effort <x>`. `off` becomes `low`. Echoed in `meta.effort`. Absent: no flag. |
| `temperature` | number | Ignored. Listed in `meta.ignored`. |
| any other param | | Ignored. |

A bad `images`, `responseSchema` or `reasoning` throws a plain `Error` before anything is spawned, from `estimate()` too.

## Model mapping

| Request `model` | `--model` |
| --- | --- |
| a key of `modelMap` | `modelMap[model]` |
| none | `textModel` (none when `""`) |
| `anthropic/claude-opus-5.5` | `claude-opus-5-5` (prefix stripped, dots to dashes) |
| `claude-*`, `opus`, `sonnet`, `haiku`, `fable` | passed through |
| anything else, e.g. `openai/gpt-6-sol` | `textModel` (none when `""`) |

`meta.modelRequested` keeps the original id whenever the request names a model.

`meta.effort` holds the `--effort` level whenever one is passed, for example `"low"` for `reasoning: "off"`. No reasoning: no flag, no `meta.effort`.

## Result

```ts
{
  text: "ok",
  costUsd: 0,
  toolCalls: [],
  finishReason: "stop",
  usage: { promptTokens: 12, completionTokens: 3, cachedTokens: 0, cacheWriteTokens: 0 },
  meta: {
    provider: "claude",
    model: "claude-opus-5-5",
    modelRequested: "anthropic/claude-opus-5.5",
    effort: "low", // only when params.reasoning is set
    listCostUsd: 0.11422,
    usage: { inputTokens: 12, outputTokens: 3 },
    ignored: ["temperature"]
  }
}
```

`usage` is typed. `promptTokens` is `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
`completionTokens` is `output_tokens`. `cachedTokens` is `cache_read_input_tokens`. `cacheWriteTokens` is
`cache_creation_input_tokens`. A count the CLI does not report is 0. `meta.usage` keeps its old keys.

`toolCalls` is always `[]` and `finishReason` always `"stop"`. `cacheSystem` is ignored.

## API

```ts
app.claude.info(); // => { provider: "claude", configured: true }
```

`configured` is true when `bin` exists: a path-like bin is checked directly, a bare name is searched in PATH.
PATH is read through `ctx.env`.

## Errors

stdout JSON is parsed first, even on a non-zero exit: the not-logged-in result exits 1 with valid JSON.

| Case | Error | promptGen |
| --- | --- | --- |
| `messages`, `tools` or `toolChoice` set (`estimate()` and `execute()`, before any spawn) | `PromptGenUnavailableError` `"unsupported"`, `[ai] Claude prompt-gen does not support messages or tools.` | falls back |
| `bin` not found | `PromptGenUnavailableError` `"missing"`, `[ai] Claude CLI not found: <bin>.` | falls back |
| Not logged in (`not logged in`, `/login`, `invalid api key`, status 401/403) | `PromptGenUnavailableError` `"auth"` | falls back |
| Plan or rate limit (`usage limit`, `limit reached`, `hit your limit`, `rate limit`, status 429) | `PromptGenUnavailableError` `"limit"` | falls back |
| `bin` not executable | `TerminalProviderError` `[ai] Claude CLI could not start: <code>.` | rethrown |
| Other reported error | `TerminalProviderError` `[ai] Claude returned an error: <first line>.` | rethrown |
| No JSON, non-zero exit | `TerminalProviderError` with the last stderr line | rethrown |
| Empty answer | `TerminalProviderError` `[ai] Claude wrote no answer.` | rethrown |
| Answer off-schema or not JSON | `TerminalProviderError` `[ai] Claude answer does not match params.responseSchema.` | rethrown |
| Timeout | `RetryableProviderError` with `kind: "timeout"` | rethrown |
| Caller abort | `signal.reason`, unchanged | rethrown |

The login and limit patterns also apply to stderr when stdout is not JSON.

## Usage

```ts
import { createApp } from "@moku-labs/ai";

// claude is a default framework plugin: no `plugins` entry needed.
const app = createApp({
  pluginConfigs: {
    promptGen: { defaultProvider: "claude", fallback: ["codex"] },
    limits: { lanes: { "prompt-gen/claude": { concurrency: 2 } } }
  }
});

await app.promptGen.generate({
  prompt: "Score this frame.",
  model: "anthropic/claude-opus-5.5",
  params: { images: [frame], responseSchema: SCORE_SCHEMA, reasoning: "low" }
});
```

The `"prompt-gen/claude"` lane caps how many local claude processes run at once, for `generate` and for runner builds.

## Logging

`ctx.log.info("claude:prompt-gen:done", { model, chars })`. `chars` is the answer length. The prompt and the answer are never logged.

## Tests

Unit and integration tests use a fake `bin`: a small shell script written into a temp dir. The real claude is never called.
