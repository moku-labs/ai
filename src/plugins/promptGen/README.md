# promptGen

> Owner of the `"prompt-gen"` task contract and the typed one-off facade `app.promptGen.*` — resolve a provider, cast once (audited), execute.

## Purpose

`promptGen` is the **task plugin** for text generation in the `@moku-labs/ai` build system. It
owns two things: the **capability contract** (`contract.ts`) that every prompt-gen provider
plugin implements and registers with `registry` under the kebab-case task key `"prompt-gen"`,
and the **typed facade** `app.promptGen.*` that consumers call for one-off, non-durable
generation. The plugin itself talks to no AI service — it is a stateless facade over the
registry: it resolves the configured (or explicitly requested) provider's handler, runtime
shape-guards it, performs this task's ONE audited cast to `PromptGenHandler` at its own
`resolve()` call site (`resolve.ts`), and delegates. The fallback walk behind `generate`
lives in `fallback.ts`; `api.ts` is the facade factory only.

The scope is deliberately minimal (a ratified M0 decision): contract + facade only — no prompt
packs, no streaming, no advanced sampling controls. It exists in M0 primarily to back the
`compose` plugin (natural language → build file), which routes all of its LLM calls through
this facade rather than touching the registry itself. Note the naming split: the **plugin/api
name** is camelCase `promptGen` (`app.promptGen`), while the **registry/task key** used in
build files and `registry.register()` calls is kebab-case `"prompt-gen"`.

Tool calling adds multi-turn fields to the contract (`messages`, `tools`, `toolChoice`,
`cacheSystem`, typed `usage`) and one library function,
[`runToolLoop`](#tool-loop--runtoolloop), which the caller journals.

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `defaultProvider` | `string` | `"openai"` | Provider used when a request doesn't name one (i.e. when `opts.provider` is omitted from `generate`/`estimate`). |
| `fallback` | `string[]` | `[]` | Providers `generate` tries in order when the chosen one is unavailable. See [Fallback](#fallback). |

Override per app via `createApp`:

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({
  pluginConfigs: { promptGen: { defaultProvider: "claude", fallback: ["codex", "openai"] } }
});
```

## The task contract

Defined in `contract.ts` and re-exported through `types.ts`. From `@moku-labs/ai` these types
are available under the `PromptGen` namespace export (`PromptGen.PromptGenRequest`, etc.).

```ts
type PromptGenRequest = {
  /** Ignored when `messages` is set (may be ""). */
  prompt: string;
  system?: string;
  model?: string;
  /** Provider maps/clamps as needed. */
  temperature?: number;
  params?: Record<string, unknown>;
  /** The turns after the system text; replaces `prompt`. */
  messages?: ChatMessage[];
  /** Tools the model may call. */
  tools?: ToolDefinition[];
  /** Default "auto". */
  toolChoice?: "auto" | "none" | "required" | { name: string };
  /** A prompt-cache breakpoint after the system text. */
  cacheSystem?: boolean;
};

type PromptGenResult = {
  /** "" when the turn is only tool calls. */
  text: string;
  costUsd: number;
  /** [] when none. */
  toolCalls: ToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "other";
  usage: PromptGenUsage;
  /** Token counts, model — metadata only; keeps its keys for compatibility. */
  meta?: Record<string, unknown>;
};

type ContentPart =
  | { type: "text"; text: string; cache?: true } // cache: a cache breakpoint after this part
  | { type: "image"; path: string; mimeType: string; hash: string }; // same shape as params.images

type ChatMessage =
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string | ContentPart[] };

/** input: the parsed JSON of the call's arguments. */
type ToolCall = { id: string; name: string; input: unknown };

/** inputSchema: a JSON schema. */
type ToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown> };

/** Counts a provider does not report are 0. */
type PromptGenUsage = {
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from the cache. */
  cachedTokens: number;
  /** Tokens written to the cache. */
  cacheWriteTokens: number;
};

type PromptGenHandler = {
  estimate(request: PromptGenRequest): { usd: number };
  execute(request: PromptGenRequest, opts: { signal?: AbortSignal }): Promise<PromptGenResult>;
};

/** Thrown by a provider that cannot serve right now, or cannot express the request. */
class PromptGenUnavailableError extends Error {
  readonly unavailable = true;
  readonly reason: "missing" | "auth" | "limit" | "unsupported";
  constructor(message: string, reason: "missing" | "auth" | "limit" | "unsupported"); // name "PromptGenUnavailableError"
}

/** Thrown by a provider when a tool call's arguments are not JSON. */
class ToolArgumentsError extends Error {
  readonly toolName: string;
  /** The unparsed arguments text, in full. */
  readonly raw: string;
  constructor(toolName: string, raw: string); // name "ToolArgumentsError"
}

/** True for `unavailable === true`, or a numeric `status` of 401, 402, 403 or 429. */
function isPromptGenUnavailable(error: unknown): boolean;
```

A request without `messages`, `tools`, `toolChoice` and `cacheSystem` is the one-turn `prompt`
request. Every provider sends it exactly as before.

A provider throws `PromptGenUnavailableError` only when it cannot serve at all: binary missing
(`"missing"`), not logged in (`"auth"`), a plan or rate limit (`"limit"`), or a request it
cannot express (`"unsupported"`). Everything else (a bad answer, invalid JSON, a timeout, a 5xx)
keeps its own error class. `contract.ts` imports no plugin, so providers value-import the
classes without a `depends` edge.

Who serves the new fields:

| Provider | `messages` / `tools` / `toolChoice` | `cacheSystem` | `usage` |
| --- | --- | --- | --- |
| `fal` | served. See [fal: Tool calling and cache](../fal/README.md#tool-calling-and-cache) | `cache_control` on the system text | prompt, completion, cached, cache-write tokens |
| `claude` | `PromptGenUnavailableError` `"unsupported"` | ignored | `promptTokens` = input + cache read + cache write; cached and cache-write tokens |
| `codex` | `PromptGenUnavailableError` `"unsupported"` | ignored | all 0. The CLI reports none |
| `openai` | `PromptGenUnavailableError` `"unsupported"` | ignored | prompt, completion, cached tokens |

The three throw in `estimate()` and in `execute()`, before any spawn or call. So `generate`
falls back to the next provider of its chain. Put `"fal"` in `fallback`, or pass
`{ provider: "fal" }`. `estimate` has no fallback: estimate a tool request with
`{ provider: "fal" }`. Every in-repo provider returns `toolCalls: []` and `finishReason: "stop"`
for a one-turn answer.

`ToolArgumentsError` is not an unavailable error. `generate` rethrows it at once; it is never
retried. Its message is
`[ai] Tool call "<name>" has arguments that are not JSON.\n  The model sent: <first 200 chars>.`

**External handlers must change.** `toolCalls`, `finishReason` and `usage` are required on
`PromptGenResult`. A `PromptGenHandler` written outside this repo must now return them. A
one-turn handler returns `toolCalls: []`, `finishReason: "stop"` and its token counts, or 0.

Provider plugins `import type { PromptGenHandler }` from this plugin's `contract.ts` to
implement it, then register the implementation with `registry` in their own `onInit`:

```ts
ctx.require(registryPlugin).register("prompt-gen", "openai", handler);
```

The registry transports handlers as `unknown` by design; `promptGen` narrows them back at its
resolve site — a runtime guard verifies function-typed `estimate` and `execute` members exist
before the single `as PromptGenHandler` cast. A registered value that fails the guard throws
`[ai] Registered prompt-gen provider "<name>" is malformed. ...`.

## API reference — `app.promptGen.*`

### `generate(request, opts?): Promise<PromptGenResult>`

One-off text generation. Builds the chain `[opts.provider ?? config.defaultProvider,
...config.fallback]`, then for each provider: shape-guards and casts the registered handler,
waits for the provider's lane `prompt-gen/<provider>/default`, and calls `execute()`,
forwarding `opts.signal`. The first answer wins; `meta.provider` names the provider that
answered. See [Fallback](#fallback) and [Lanes](#lanes).

**NOT journaled.** This is the direct facade path — no journal entry, no resume, no progress
tracking. For durable, resumable execution put a `task: prompt-gen` item in a build file and
run it via `app.runner.run()`. For a journaled tool conversation see
[Tool loop — `runToolLoop`](#tool-loop--runtoolloop).

- **`request`**: `PromptGenRequest` — the prompt plus optional `system`, `model`,
  `temperature`, `params`; or `messages`, `tools`, `toolChoice`, `cacheSystem` for a tool turn.
- **`opts.signal`**: `AbortSignal` (optional) — cancels the request; forwarded to the
  handler's `execute()`.
- **`opts.provider`**: `string` (optional) — head of the chain; defaults to
  `config.defaultProvider`.
- **Returns**: `Promise<PromptGenResult>` — generated `text`, `costUsd`, `toolCalls`,
  `finishReason`, `usage`, and `meta` with `provider` set to the answering provider (merged
  over the handler's own `meta`).
- **Throws**: the pinned two-line error when the head of the chain is unregistered:

  ```
  [ai] No prompt-gen provider named "<name>" is registered.
    Available: <comma list or "none">.
  ```

  a "malformed provider" error when the registered value fails the handler shape guard, the
  first error that is not "unavailable", or the last error when every provider is unavailable.

```ts
const result = await app.promptGen.generate(
  { prompt: "Describe a sunset over the ocean.", temperature: 0.7 },
  { provider: "openai", signal: controller.signal }
);
console.log(result.text, result.costUsd);
```

### `estimate(request, opts?): { usd: number }`

Cost estimate without executing. Resolves the head of the chain exactly as `generate()` does
(same override/default logic, same unknown-provider and malformed-handler errors), then calls
that handler's `estimate()`. It runs nothing, so it has no fallback and takes no lane.
Synchronous.

- **`request`**: `PromptGenRequest` — the request to estimate.
- **`opts.provider`**: `string` (optional) — provider override; defaults to
  `config.defaultProvider`.
- **Returns**: `{ usd: number }` — estimated cost in USD.
- **Throws**: same errors as `generate()`.

```ts
const { usd } = app.promptGen.estimate({ prompt: "Summarize this changelog." });
if (usd > 0.01) throw new Error("too expensive for a one-off");
```

### `providers(): string[]`

Provider names registered for the `"prompt-gen"` task, in registration order — the first
registered is the task default from the registry's perspective. Delegates to
`registry.providers("prompt-gen")`. Never throws; returns `[]` when nothing is registered.

```ts
app.promptGen.providers(); // ["openai", "codex", "claude"] in a default app
```

## Fallback

`generate` walks `[opts.provider ?? defaultProvider, ...fallback]`. A name listed twice is tried
once.

- It moves to the next provider only when the current one is **unavailable**:
  `isPromptGenUnavailable(error)` is true, or the provider's lane rejects with
  `reason: "breaker-open"`.
- Any other error is rethrown at once. A bad or invalid answer never switches provider.
- An abort is rethrown at once, even if the error looks unavailable.
- Every provider unavailable: the last error is rethrown.
- The head of the chain unregistered: the pinned unknown-provider error. A later unregistered
  name is skipped with `warn("prompt-gen:fallback-skip", { provider, reason: "unregistered" })`.
- Each switch logs `warn("prompt-gen:fallback", { from, to, reason })`. `reason` is
  `error.reason` (`missing`, `auth`, `limit`, `unsupported`, `breaker-open`), else
  `http-<status>`.
- `fallback: []` (the default) keeps the single-provider behaviour.
- The runner path does not fall back: a `task: prompt-gen` build item uses one provider.

```ts
const app = createApp({
  pluginConfigs: { promptGen: { defaultProvider: "claude", fallback: ["codex"] } }
});
await app.start();
const result = await app.promptGen.generate({ prompt: "Name this shot in three words." });
// claude not logged in: result.meta.provider === "codex", one prompt-gen:fallback warn
```

## Lanes

Each attempt runs inside the provider's `limits` lane, the same key the runner uses:
`prompt-gen/<provider>/default`. The lane is released when the attempt settles, on success
and on error. `generate` never reports outcomes, so breaker state stays owned by the runner.
`estimate` and `providers` take no lane.

Direct calls therefore obey `limits.defaults` (rpm 60, concurrency 4) or a lane override.
Local CLIs should not run many at once; `limits` is a core plugin, so its config goes to
`createCore` (`pluginConfigs.limits`):

```ts
limits: { lanes: { "prompt-gen/claude": { concurrency: 2 }, "prompt-gen/codex": { concurrency: 2 } } }
```

The prefix key `"prompt-gen/claude"` matches the full lane `"prompt-gen/claude/default"`.

## Tool loop — `runToolLoop`

`runToolLoop(options)` runs a tool-calling conversation to its end. It is a library function
exported from `@moku-labs/ai`, not a plugin. It calls only `options.generate`, so it works with
any provider that serves tools. Today that is `fal`.

The loop keeps no state of its own. Every model call and every tool call is one step of the
caller's journal, `options.step(key, work)`. The journal runs `work` once per key and returns the
stored value on a replay. A restart with the same journal replays every finished step: no model
call and no tool runs twice.

```ts
function runToolLoop(options: RunToolLoopOptions): Promise<RunToolLoopResult>;
```

### Options

| Option | Type | Meaning |
| --- | --- | --- |
| `generate` | `(request, signal) => Promise<PromptGenResult>` | One model call. Usually `app.promptGen.generate` with `provider: "fal"`. |
| `model` | `string` | Model id sent with every call. |
| `reasoning` | `"off" \| "low" \| "medium" \| "high"` | Sent as `params.reasoning` when set. |
| `system` | `string` | System text of every call. Always sent with `cacheSystem: true`. |
| `messages` | `ChatMessage[]` | The conversation so far. Never changed. |
| `tools` | `readonly ToolSpec[]` | Tools the model may call. |
| `budget.usd` | `number` | The limit in USD. |
| `budget.spentUsd` | `number` | Spend before this run. Default 0. |
| `budget.finishAt` | `number` | Fraction of `usd`, 0–1, where finish mode starts. |
| `budget.spent` | `() => Promise<number>` | Spend outside the loop's steps, such as child rows. Read at every check. |
| `maxSteps` | `number` | Most model calls, replayed ones included. |
| `step` | `<T>(key, work) => Promise<T>` | The caller's journal. See [Step keys](#step-keys). |
| `onStep` | `(event: LoopEvent) => void` | Called with every event. |
| `finishNote` | `string` | User text added once, before the first model call made in finish mode. |
| `keepImages` | `number` | Assistant turns whose tool-result images stay in the request. Default 2. |
| `signal` | `AbortSignal` | Cancels the loop. |

Each model call sends `{ prompt: "", system, model, messages, tools, cacheSystem: true }`, plus
`params: { reasoning }` when `reasoning` is set. `messages` is the history with old images
trimmed (see `keepImages`). Each tool becomes
`{ name, description, inputSchema }`, where `inputSchema` is
`z.toJSONSchema(schema, { io: "input" })` without the `$schema` key.

### Tools

| `ToolSpec` field | Meaning |
| --- | --- |
| `name`, `description` | What the model sees. |
| `schema` | A zod schema. It checks the model's input and becomes the JSON schema in the request. |
| `estimateUsd(input)` | Optional cost estimate for the breaker. Absent means 0 and no check. |
| `run(input, signal)` | Runs the tool. Returns a `ToolOutput`. |
| `start(input, signal)` | Optional first half: starts outside work, returns a JSON-safe `{ started, rows? }`. |
| `wait(started, signal)` | Optional second half: waits for the started work, returns a `ToolOutput`. |

| `ToolOutput` field | Meaning |
| --- | --- |
| `value` | The tool's own result, for the caller. The model never sees it. |
| `content` | `ContentPart[]` the model reads. Images are allowed. `[]` is sent as `"(no output)"`. |
| `costUsd` | Cost of the call. Counts toward the budget. |
| `rows` | Optional ids of outside work the tool started. Opaque to the loop. |

When a tool has both `start` and `wait`, the loop uses them and not `run`. A restart after
`start` only waits, so the outside work never starts twice.

The loop answers some calls itself, with one text step at cost 0:

| Call | Tool result |
| --- | --- |
| Unknown tool name | `Unknown tool "<name>".` |
| Input fails the zod schema | `Invalid input for <name>: <z.prettifyError>`. The model may retry. |

A tool that throws ends the loop with that error. When the signal is aborted at that point, the
loop returns `stoppedBy: "cancel"` instead. A `generate` error works the same way. A
`ToolArgumentsError` from fal is a `generate` error.

### Step keys

| Key | Value stored | Cost |
| --- | --- | --- |
| `model:<n>` | `{ result, finish? }`: the `PromptGenResult`, and `finish: { spentUsd }` when finish mode started before this call | `result.costUsd` |
| `tool:<callId>` | the `ToolOutput`, or the loop's own text answer | `output.costUsd`, or 0 |
| `tool:<callId>:start` | `{ started, rows }` | 0 |
| `tool:<callId>:wait` | the `ToolOutput` | `output.costUsd` |

`<n>` is the 1-based model call of this run. Every stored value carries its cost, so a replay
rebuilds `spentUsd`. The journal passes a signal to `work`; the tool or `generate` gets that
signal. Pass `options.signal` or your own.

`work` may throw: the loop's own budget stop, or a model or tool error. The journal must not store
a work that throws, and must pass its error on unchanged.

### Budget

`spent` = `budget.spentUsd` + the cost of every step (replayed ones too) + `await budget.spent()`.

- **Before a model call**: `spent >= usd` stops the loop with `stoppedBy: "budget"`. A loop
  without costed tools still stops.
- **Before a tool with `estimateUsd`**: `spent + estimate > usd` stops the loop. The tool does
  not run.
- Both stops emit `{ kind: "budget", mode: "stop" }`.
- **Every check runs inside the step it guards**: `model:<n>` before `generate`, and `tool:<callId>`
  or `tool:<callId>:start` before the tool. `:wait` never checks. A replayed step is never checked
  again, even when `budget.spent()` has grown since. So a crash after a paid `start` replays and
  waits; it does not stop with `Not run: budget.`.
- **Finish mode**: the first model call made with `spent >= finishAt × usd` starts finish mode,
  once. With `finishNote` set, the note is the last message of that call's request, and joins the
  history just before its answer, unless a user message already has exactly that text. The step
  value records it, so a replay puts the note at the same place. The loop emits
  `{ kind: "budget", mode: "finish" }` just before that call's `model` event. A run that ends
  before another model call never enters finish mode.
- A `"budget"`, `"steps"` or `"cancel"` stop answers every open call of the last assistant
  turn with `Not run: <reason>.`, for example `Not run: budget.`. So `result.messages` is a
  valid history to resume from.

### Stops

| `stoppedBy` | When |
| --- | --- |
| `"done"` | A model turn has no tool calls. `finalText` is its text. |
| `"budget"` | The breaker. See [Budget](#budget). |
| `"steps"` | Before a model call, `maxSteps` model calls already ran. Checked before the budget. |
| `"cancel"` | `signal` was aborted. The loop stops after the running step settles. |
| `"asked"` | The model called the caller's `ask` tool. |

- **`ask`**: define a tool named `"ask"` to let the model ask the person. Its input is checked
  like any tool; a bad input is answered and the loop goes on. A checked `ask` call is never
  run: the other calls of the turn run first, then the loop stops with `asked: { input }`. The
  `ask` call stays open in `messages`; the caller appends the answer as
  `{ role: "tool", toolCallId, content }`. Only the first `ask` of a turn waits for the person;
  a second one gets the tool result `Ask one question at a time.`. Without an `ask` tool, an
  `ask` call is an unknown tool.
- **`keepImages`**: before each model call, image parts of tool results older than the last N
  assistant turns become `[image dropped: <file name>]` text. Only the request changes;
  `result.messages` keeps every image.
- **`cancel`**: the abort is checked after every step and before every model call. Between the
  two halves of a start/wait tool it stops before `wait`.
- **`maxSteps`** counts model calls, replayed ones too.

### Result

| Field | Meaning |
| --- | --- |
| `stoppedBy` | `"done" \| "budget" \| "steps" \| "cancel" \| "asked"` |
| `spentUsd` | Spend at the stop: `budget.spentUsd` + step costs + `budget.spent()`. |
| `steps` | Model calls made, replayed ones included. |
| `messages` | The given messages, then every turn of this run. |
| `finalText` | The last model text; `null` when it was empty or no model call ran. |
| `asked` | `{ input }` of the `ask` call; set only for `"asked"`. |

### Loop events

| `kind` | Fields | When |
| --- | --- | --- |
| `"model"` | `step`, `text`, `toolCalls`, `costUsd`, `usage` | After each model step, replayed ones too. |
| `"tool"` | `step`, `name`, `callId`, `costUsd`, `summary`, `rows` | After each answered call. A start/wait tool emits one, after `wait`. |
| `"budget"` | `spentUsd`, `limitUsd`, `mode` | `"finish"` once, just before the `model` event of the first call in finish mode; `"stop"` when the breaker stops the loop. |

`step` is the 1-based model turn; a tool event carries the turn of its call. `summary` is the
first text part of the result, cut to 200 characters, `""` when none. `rows` are the start
half's rows, else `ToolOutput.rows`, else `[]`.

### Example

```ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { createApp, runToolLoop } from "@moku-labs/ai";
import type { PromptGen } from "@moku-labs/ai";

const app = createApp({});
await app.start();

// A free tool: the first frame of a shot, as an image the model can see.
const readFrame: PromptGen.ToolSpec<{ shot: number }> = {
  name: "read_frame",
  description: "Return the first frame of a storyboard shot as an image.",
  schema: z.object({ shot: z.number().int().min(1) }),
  run: async ({ shot }) => {
    const path = `frames/s${shot}.png`;
    const hash = createHash("sha256").update(await readFile(path)).digest("hex");
    return {
      value: { shot, path },
      content: [
        { type: "text", text: `First frame of shot ${shot}.` },
        { type: "image", path, mimeType: "image/png", hash }
      ],
      costUsd: 0
    };
  }
};

// Never run: a call to "ask" stops the loop with stoppedBy "asked".
const askPerson: PromptGen.ToolSpec<{ question: string }> = {
  name: "ask",
  description: "Ask the person a question the frames cannot answer.",
  schema: z.object({ question: z.string() }),
  run: async () => {
    throw new Error("ask is never run");
  }
};

// The journal: one value per key. A Map lives in memory only; keep it on disk to survive a crash.
const journal = new Map<string, unknown>();
const controller = new AbortController();
async function step<T>(
  key: string,
  work: (signal: AbortSignal) => Promise<{ value: T; costUsd: number }>
): Promise<T> {
  if (journal.has(key)) return journal.get(key) as T;
  const { value } = await work(controller.signal);
  journal.set(key, value);
  return value;
}

const options: PromptGen.RunToolLoopOptions = {
  generate: (request, signal) => app.promptGen.generate(request, { signal, provider: "fal" }),
  model: "anthropic/claude-opus-5.5",
  system: "You review storyboard frames. Read the frames you need, then answer in one paragraph.",
  messages: [{ role: "user", content: "Is the subject framed the same way in shots 1 and 2?" }],
  tools: [readFrame, askPerson],
  budget: { usd: 0.5, finishAt: 0.8 },
  maxSteps: 10,
  step,
  finishNote: "The budget is nearly spent. Answer with what you have.",
  onStep: event => {
    if (event.kind === "tool") console.log(`turn ${event.step}: ${event.name}: ${event.summary}`);
  },
  signal: controller.signal
};

const result = await runToolLoop(options);
console.log(result.stoppedBy); // "done", or "asked" when the model called ask
console.log(result.finalText); // the model's last text
console.log(result.spentUsd); // the model calls' cost; read_frame costs 0
await app.stop();
```

### Resume and caveats

- **A crash restart uses the same journal keys.** Run `runToolLoop` again with the same options
  and the same journal: finished steps replay, the rest runs.
- **A continued conversation needs a new key space.** Keys start again at `model:1` on every
  call. After an `ask` or a stop, the next run has new messages, so give its journal a new key
  prefix. Otherwise `model:1` replays the first run's answer.
- **`result.spentUsd` already includes `budget.spent()`.** Pass it on as `budget.spentUsd`, and
  let `spent()` count only spend that is new since then. Otherwise outside spend counts twice.
- **Call ids must be unique across turns.** The tool keys use only the call id. A provider that
  reuses an id in a later turn would replay the earlier tool result.

Continue after an `ask`, with the options of the example, under a new key prefix:

```ts
const lastTurn = result.messages.findLast(message => message.role === "assistant");
const askCallId =
  lastTurn?.role === "assistant" ? lastTurn.toolCalls?.find(call => call.name === "ask")?.id : undefined;
if (result.stoppedBy === "asked" && askCallId !== undefined) {
  const messages: PromptGen.ChatMessage[] = [
    ...result.messages,
    { role: "tool", toolCallId: askCallId, content: "Take 2." }
  ];
  const resumed = await runToolLoop({
    ...options,
    messages,
    budget: { ...options.budget, spentUsd: result.spentUsd },
    step: (key, work) => step(`resume-1/${key}`, work)
  });
}
```

## Events

None. `promptGen` emits nothing and listens to nothing — it is a pure request/response facade.

## Usage examples

One-off generation with the framework:

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({
  pluginConfigs: { promptGen: { defaultProvider: "openai" } }
});
await app.start();

// Estimate first, then generate.
const request = {
  prompt: "Write a one-line tagline for a durable AI build system.",
  system: "You are a concise copywriter."
};
const { usd } = app.promptGen.estimate(request);
console.log(`Estimated cost: $${usd}`);

const result = await app.promptGen.generate(request);
console.log(result.text);

await app.stop();
```

Cancellation and provider override:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 30_000);

const result = await app.promptGen.generate(
  { prompt: "Draft alt text for a product image.", model: "gpt-4o-mini" },
  { provider: "openai", signal: controller.signal }
);
```

Implementing a custom provider (Layer-3 plugin):

```ts
import { createPlugin, registryPlugin } from "@moku-labs/ai";
import type { PromptGen } from "@moku-labs/ai";

const handler: PromptGen.PromptGenHandler = {
  estimate: request => ({ usd: request.prompt.length * 0.00001 }),
  execute: async request => ({
    text: `echo: ${request.prompt}`,
    costUsd: 0,
    toolCalls: [],
    finishReason: "stop",
    usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 }
  })
};

export const echoPlugin = createPlugin("echo", {
  depends: [registryPlugin],
  onInit: ctx => {
    ctx.require(registryPlugin).register("prompt-gen", "echo", handler);
  },
  api: () => ({})
});
```

Durable path — the same task in a build file, executed by `runner` (journaled, resumable):

```yaml
items:
  - task: prompt-gen
    input:
      prompt: "Describe a sunset over the ocean."
```

## Integration

- **`limits` and `log` (core APIs).** Injected on `ctx`, no `depends` entry. `generate`
  acquires one lane per attempt and logs one warn per provider switch.
- **`registry` (dependency).** The only plugin `promptGen` requires. Providers `register()`
  handlers under `"prompt-gen"`; `promptGen` calls `registry.resolve("prompt-gen", provider)`
  and `registry.providers("prompt-gen")` via `ctx.require(registryPlugin)`. Because `registry`
  is a dumb transport (`unknown` in, `unknown` out), `promptGen` owns the single audited cast
  back to `PromptGenHandler`, protected by a runtime shape guard.
- **`compose` (consumer, facade edge).** `compose` declares `promptGenPlugin` as a dependency
  and calls `ctx.require(promptGenPlugin).generate()` for every generation/repair attempt of
  its natural-language → build-file loop, forwarding its abort signal. It never touches the
  registry for text generation — the audited cast stays in exactly one place.
- **`openai` (provider).** Fulfills the contract: in its `onInit` it builds a
  `PromptGenHandler` (`createPromptGenHandler(ctx)`) and registers it as
  `registry.register("prompt-gen", "openai", handler)` — which is why the config default is
  `"openai"`. Any plugin registering a conforming handler under `"prompt-gen"` becomes
  selectable via `opts.provider` or `defaultProvider`.
- **`codex` / `claude` (providers).** Register `"prompt-gen"` handlers over the local `codex`
  and `claude` CLIs in their own `onInit`, after `openai`. A default app therefore lists
  `["openai", "codex", "claude"]`. These two and `openai` throw `"unsupported"` for
  `messages`, `tools` and `toolChoice`.
- **`fal` (provider).** Registers `("prompt-gen", "fal")`, the provider that serves `messages`,
  `tools`, `toolChoice` and `cacheSystem`. See
  [fal: Tool calling and cache](../fal/README.md#tool-calling-and-cache).
- **`runner` / `buildfile` (durable path).** Build-file items with `task: prompt-gen` are
  executed by `runner`, which resolves the same registered handlers through the registry with
  its own audited boundary — journaled and resumable. `app.promptGen.generate()` deliberately
  bypasses all of that for cheap one-off calls.

## Exports

From `@moku-labs/ai`:

- `promptGenPlugin` — the plugin instance (already registered in the framework; reference it
  in `depends` when a Layer-3 plugin needs the facade via `ctx.require`).
- `PromptGenUnavailableError`, `isPromptGenUnavailable` — the "provider unavailable" error and
  its predicate, for provider plugins and for callers with their own retry loop.
- `ToolArgumentsError` — a tool call whose arguments are not JSON; `toolName` and `raw`.
- `runToolLoop` — the journaled tool loop. See [Tool loop](#tool-loop--runtoolloop).
- `PromptGen` — namespace with all public types: `Config`, `PromptGenApi`,
  `PromptGenContext`, `PromptGenRequest`, `PromptGenResult`, `PromptGenHandler`,
  `PromptGenUsage`, `ContentPart`, `ChatMessage`, `ToolCall`, `ToolDefinition`, `ToolSpec`,
  `ToolOutput`, `LoopEvent`, `RunToolLoopOptions`, `RunToolLoopResult`, `RegistryApi`.
