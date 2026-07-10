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
`resolve()` call site, and delegates.

The scope is deliberately minimal (a ratified M0 decision): contract + facade only — no prompt
packs, no streaming, no advanced sampling controls. It exists in M0 primarily to back the
`compose` plugin (natural language → build file), which routes all of its LLM calls through
this facade rather than touching the registry itself. Note the naming split: the **plugin/api
name** is camelCase `promptGen` (`app.promptGen`), while the **registry/task key** used in
build files and `registry.register()` calls is kebab-case `"prompt-gen"`.

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `defaultProvider` | `string` | `"openai"` | Provider used when a request doesn't name one (i.e. when `opts.provider` is omitted from `generate`/`estimate`). |

Override per app via `createApp`:

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({
  pluginConfigs: { promptGen: { defaultProvider: "openai" } }
});
```

## The task contract

Defined in `contract.ts` and re-exported through `types.ts`. From `@moku-labs/ai` these types
are available under the `PromptGen` namespace export (`PromptGen.PromptGenRequest`, etc.).

```ts
type PromptGenRequest = {
  prompt: string;
  system?: string;
  model?: string;
  /** Provider maps/clamps as needed. */
  temperature?: number;
  params?: Record<string, unknown>;
};

type PromptGenResult = {
  text: string;
  costUsd: number;
  /** Token counts, model — metadata only. */
  meta?: Record<string, unknown>;
};

type PromptGenHandler = {
  estimate(request: PromptGenRequest): { usd: number };
  execute(request: PromptGenRequest, opts: { signal?: AbortSignal }): Promise<PromptGenResult>;
};
```

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

One-off text generation. Resolves the provider (explicit `opts.provider`, else
`config.defaultProvider`), shape-guards and casts the registered handler, and calls its
`execute()` immediately, forwarding `opts.signal`.

**NOT journaled.** This is the direct facade path — no journal entry, no resume, no progress
tracking. For durable, resumable execution put a `task: prompt-gen` item in a build file and
run it via `app.runner.run()`.

- **`request`**: `PromptGenRequest` — the prompt plus optional `system`, `model`,
  `temperature`, `params`.
- **`opts.signal`**: `AbortSignal` (optional) — cancels the request; forwarded to the
  handler's `execute()`.
- **`opts.provider`**: `string` (optional) — provider override; defaults to
  `config.defaultProvider`.
- **Returns**: `Promise<PromptGenResult>` — generated `text`, `costUsd`, optional `meta`.
- **Throws**: the pinned two-line error when the provider is unregistered:

  ```
  [ai] No prompt-gen provider named "<name>" is registered.
    Available: <comma list or "none">.
  ```

  and a "malformed provider" error when the registered value fails the handler shape guard.

```ts
const result = await app.promptGen.generate(
  { prompt: "Describe a sunset over the ocean.", temperature: 0.7 },
  { provider: "openai", signal: controller.signal }
);
console.log(result.text, result.costUsd);
```

### `estimate(request, opts?): { usd: number }`

Cost estimate without executing. Resolves the provider exactly as `generate()` does
(same override/default logic, same unknown-provider and malformed-handler errors), then calls
the handler's `estimate()` instead of `execute()`. Synchronous.

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
app.promptGen.providers(); // ["openai"]
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
  execute: async request => ({ text: `echo: ${request.prompt}`, costUsd: 0 })
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
- **`runner` / `buildfile` (durable path).** Build-file items with `task: prompt-gen` are
  executed by `runner`, which resolves the same registered handlers through the registry with
  its own audited boundary — journaled and resumable. `app.promptGen.generate()` deliberately
  bypasses all of that for cheap one-off calls.

## Exports

From `@moku-labs/ai`:

- `promptGenPlugin` — the plugin instance (already registered in the framework; reference it
  in `depends` when a Layer-3 plugin needs the facade via `ctx.require`).
- `PromptGen` — namespace with all public types: `Config`, `PromptGenApi`,
  `PromptGenContext`, `PromptGenRequest`, `PromptGenResult`, `PromptGenHandler`,
  `RegistryApi`.
