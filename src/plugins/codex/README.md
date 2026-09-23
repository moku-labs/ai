# codex

> Image provider over the local Codex CLI (`codex exec`). Standard tier. Registers `("image", "codex")` with the registry in `onInit`.

## Purpose

Codex runs on the user's ChatGPT plan, so the marginal price of one image is $0. That zero is written
as an explicit entry in the price table. A model without a price throws, it never counts as free (D13).

Each call owns one temp dir under `workDir`:

1. Refs are copied in as `ref-1.png`, `ref-2.jpg`, ... Store paths have no extension, and codex reads the type from it.
2. `codex exec` runs with `-C <dir>` and stdin closed. An open stdin makes codex wait forever.
3. The image is `output.png`, else the newest `.png/.jpg/.jpeg/.webp` that is not a ref.
4. The dir is removed in `finally`, on success and on every failure.

## Configuration

Set via `createApp({ pluginConfigs: { codex: { ... } } })`.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `bin` | `string` | `"codex"` | Executable. A bare name is looked up on PATH. |
| `model` | `string` | `"gpt-6-astra"` | Model used when a request names none. |
| `reasoningEffort` | `string` | `"low"` | Passed as `-c model_reasoning_effort="<effort>"`. |
| `timeoutMs` | `number` | `600_000` | Kill the CLI (SIGTERM) after this long. |
| `workDir` | `string` | `".moku/tmp"` | Root for per-call temp dirs, resolved against the cwd. |
| `priceOverrides` | `Record<string, number>` | `{}` | USD per image by model, merged over the bundled table. |

Bundled prices: `{ "gpt-6-astra": 0 }`.

## Command

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

## Errors

| Case | Error | Runner class |
| --- | --- | --- |
| Unknown model price | `Error` `[ai] No price for codex model "<m>".` (from `estimate()` and `execute()`) | terminal |
| `bin` not found | `TerminalProviderError` `[ai] Codex CLI not found: <bin>.` | terminal |
| `bin` not executable | `TerminalProviderError` `[ai] Codex CLI could not start: <code>.` | terminal |
| Non-zero exit | `TerminalProviderError` with the last stderr line | terminal |
| Exit 0, no image | `TerminalProviderError` `[ai] Codex finished without writing an image.` | terminal |
| Timeout | `RetryableProviderError` with `kind: "timeout"` | retryable |
| Caller abort | `signal.reason`, rethrown unchanged | pause |

Terminal errors carry neither `kind` nor `status`, so the runner classifies them as `"unknown"`.

## Logging

`ctx.log.info("codex:image:done", { model, bytes })`. The prompt is never logged.

## Tests

Unit tests use a fake `bin`: a small shell script written into a temp dir. The real codex is never called.
