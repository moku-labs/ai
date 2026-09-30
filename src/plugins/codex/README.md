# codex

> Image and prompt-gen provider over the local Codex CLI (`codex exec`). Complex tier. Registers `("image", "codex")`, then `("prompt-gen", "codex")`, with the registry in `onInit`.

## Purpose

Codex runs on the user's ChatGPT plan, so the marginal price of one image is $0. That zero is written
as an explicit entry in the price table. A model without a price throws, it never counts as free (D13).
Prompt-gen answers are plan-billed too: every result has `costUsd: 0`.

Each call owns one temp dir under `workDir` (`os.tmpdir()` when `workDir` is `""`):

1. Refs are copied in as `ref-1.png`, `ref-2.jpg`, ... Store paths have no extension, and codex reads the type from it.
2. `codex exec` runs with `-C <dir>` and stdin closed. An open stdin makes codex wait forever.
3. The image is `output.png`, else the newest `.png/.jpg/.jpeg/.webp` that is not a ref.
4. The dir is removed in `finally`, on success and on every failure.

## Configuration

Set via `createApp({ pluginConfigs: { codex: { ... } } })`.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `bin` | `string` | `"codex"` | Executable. A bare name is looked up on PATH. |
| `model` | `string` | `"gpt-6-astra"` | Image model used when an image request names none. |
| `reasoningEffort` | `string` | `"low"` | Passed as `-c model_reasoning_effort="<effort>"`, for both tasks. |
| `timeoutMs` | `number` | `600_000` | Kill the CLI (SIGTERM) after this long. |
| `workDir` | `string` | `".moku/tmp"` | Root for per-call temp dirs, resolved against the cwd. `""` means `os.tmpdir()`. |
| `priceOverrides` | `Record<string, number>` | `{}` | USD per image by model, merged over the bundled table. |
| `textModel` | `string` | `""` | Prompt-gen model when the request model maps to none. `""` leaves `-m` out: codex's own default. |
| `modelMap` | `Record<string, string>` | `{}` | Exact request-model id to codex model. Checked before every other mapping rule. |

Bundled prices: `{ "gpt-6-astra": 0 }`.

## Command (image)

```
codex exec -m <model> -c model_reasoning_effort="<effort>" --sandbox workspace-write
  --skip-git-repo-check -C <dir> -o <dir>/last-message.txt [--image <ref>]... -- <prompt>
```

`--` is mandatory. `--image` is greedy and would take the prompt as another image otherwise.

## Prompt

One line each: the instruction to generate exactly one image, the brief (`request.prompt`),
`Avoid: <negative>.` when given, the size from `aspect`, a line naming the attached refs when there are any,
and the save instruction (`output.png`, no other files, reply with the file name only).

| `aspect` | Size line |
| --- | --- |
| `"9:16"` (default, also for unknown values) | `Portrait, 1024x1536.` |
| `"16:9"` | `Landscape, 1536x1024.` |
| `"1:1"` | `Square, 1024x1024.` |

## API

```ts
app.codex.info(); // => { provider: "codex", configured: true, models: ["gpt-6-astra"] }
```

`configured` is true when `bin` exists: a path-like bin is checked directly, a bare name is searched in PATH.
PATH is read through `ctx.env`, never `process.env`.

The capability itself is the registered `ImageHandler`:

```ts
await app.image.generate({ prompt: "cream-walled patisserie, night", aspect: "9:16" }, { provider: "codex" });
app.image.estimate({ prompt: "p" }, { provider: "codex" }); // => { usd: 0 }
```

## Prompt-gen

`app.promptGen.generate(request, { provider: "codex" })` runs the registered `PromptGenHandler`.
Each call owns one temp dir under `workDir`, removed in `finally`.

```
codex exec [-m <model>] -c model_reasoning_effort="<effort>" --sandbox read-only
  --skip-git-repo-check -C <dir> -o <dir>/last-message.txt
  [--image <abs path>]... -- <prompt>
```

- codex has no system flag. With `system` set, the prompt is `system`, a blank line, then `prompt`.
- With `params.responseSchema` set, the answer rule and the schema follow after another blank line.
- Never `--output-schema`. Codex sends it as an OpenAI strict `json_schema`, and strict mode rejects what
  `z.toJSONSchema` makes: `propertyNames`, record maps, optional keys, `$schema`.
- The answer is `last-message.txt`, trimmed.
- `estimate()` validates the params and returns `{ usd: 0 }`.
- `meta` is `Codex.CodexPromptMeta`: `{ provider: "codex", model?, modelRequested?, effort, ignored? }`. `effort` is the key claude uses too.

```ts
await app.promptGen.generate({ prompt: "Say ok", system: "Be terse." }, { provider: "codex" });
// => { text: "ok", costUsd: 0, meta: { provider: "codex", effort: "low" } }
```

### Params

| Param | Shape | Effect |
| --- | --- | --- |
| `params.images` | `ImageFile` or `ImageFile[]` | Copied into the call dir as `ref-<n>.<ext>`, one `--image <abs path>` each. |
| `params.responseSchema` | plain JSON-schema object | Appended to the prompt as compact JSON. The answer is parsed (one ```` ```json ```` fence stripped) and checked with `z.fromJSONSchema(schema)`. `text` is the validated JSON, re-stringified. |
| `params.reasoning` | `"off"`, `"low"`, `"medium"`, `"high"` | `-c model_reasoning_effort="<x>"`. `off` becomes `low`. Absent: `reasoningEffort`. |
| `temperature` | number | Ignored. `meta.ignored: ["temperature"]`. |
| any other param | any | Ignored. |

A bad shape throws a plain `Error` before codex is spawned:
`[ai] Codex params.images must be image files.`, `[ai] Codex params.responseSchema must be a JSON schema object.`,
`[ai] Codex params.reasoning must be off, low, medium or high.`

### Model mapping

Request model ids are OpenRouter style. In order:

1. An exact `modelMap` entry wins.
2. No request model: `textModel`.
3. `openai/<id>`: the prefix is stripped. `openai/gpt-6-sol` becomes `gpt-6-sol`.
4. A bare codex id passes: `gpt-*`, `o<digit>*`, `codex-*`. `o4-mini` stays `o4-mini`.
5. Anything else, such as `anthropic/claude-opus-5.5`: `textModel`.

An empty `textModel` means no `-m` flag. `meta.modelRequested` keeps the original id.

### Unavailable errors

These throw `PromptGenUnavailableError`, so `promptGen` moves on to its next `fallback` provider.

| Case | `reason` | Signal | Message |
| --- | --- | --- | --- |
| Binary missing | `missing` | spawn `ENOENT` | `[ai] Codex CLI not found: <bin>.` |
| Not logged in | `auth` | API error status 401 or 403, or stderr matches `/401 Unauthorized\|not logged in\|codex login/i` | `[ai] Codex CLI is not logged in.` / `Run codex login, or use another provider.` |
| Plan or rate limit | `limit` | API error status 429, or stderr matches `/usage limit\|rate limit\|429\|too many requests/i` | `[ai] Codex CLI hit its plan or rate limit.` / `Wait for the reset, or use another provider.` |

Any other failure is not a reason to switch:

| Case | Error |
| --- | --- |
| Exit 0, answer missing or blank | `TerminalProviderError` `[ai] Codex wrote no answer.` |
| Schema set, answer off-schema or not JSON | `TerminalProviderError` `[ai] Codex answer does not match params.responseSchema.` |
| Non-zero exit, timeout, abort | as in [Errors](#errors) |

### Lane

`promptGen.generate` and runner builds wait for the `prompt-gen/codex/default` lane. A local CLI should not run many
calls at once, so cap it:

```ts
createApp({ pluginConfigs: { limits: { lanes: { "prompt-gen/codex": { concurrency: 2 } } } } });
```

## Errors

| Case | Error | Runner class |
| --- | --- | --- |
| Unknown model price | `Error` `[ai] No price for codex model "<m>".` (from `estimate()` and `execute()`) | terminal |
| `bin` not found | `PromptGenUnavailableError` `[ai] Codex CLI not found: <bin>.`, `reason: "missing"` | terminal |
| Not logged in, plan or rate limit | `PromptGenUnavailableError`, `reason: "auth"` or `"limit"` | terminal |
| `bin` not executable | `TerminalProviderError` `[ai] Codex CLI could not start: <code>.` | terminal |
| Non-zero exit | `TerminalProviderError` `[ai] Codex exited with code <n>: <detail>.` | terminal |
| Exit 0, no image | `TerminalProviderError` `[ai] Codex finished without writing an image.` | terminal |
| Timeout | `RetryableProviderError` with `kind: "timeout"` | retryable |
| Caller abort | `signal.reason`, rethrown unchanged | pause |

The `<detail>` of a non-zero exit is `error.message` of the API error codex prints as `ERROR: {…}` on stderr,
or as JSON on stdout. Without one it is the last stderr line. Either is capped at 300 characters. An API error
with a status decides by the status alone: 401 or 403 is `auth`, 429 is `limit`, and any other status, a 400
`invalid_json_schema` included, is terminal. An API error without a status is read by its wording.

Terminal and unavailable errors carry neither `kind` nor `status`, so the runner classifies them as `"unknown"`.

## Logging

`ctx.log.info("codex:image:done", { model, bytes })` and
`ctx.log.info("codex:prompt-gen:done", { model, chars })` (`model` is `"default"` when no `-m` was passed).
The prompt and the answer are never logged.

## Tests

Unit tests use a fake `bin`: a small shell script written into a temp dir. The real codex is never called.
