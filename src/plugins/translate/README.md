# translate

> Owner of the translate capability contract and the typed one-off facade `app.translate.*`.

## Purpose

`translate` is the task plugin for text translation in the `@moku-labs/ai` build system. It does
not talk to any AI provider itself — instead it owns the *capability contract* for the
`"translate"` task (`TranslateRequest`, `TranslateResult`, `TranslateHandler` in `contract.ts`)
and exposes a typed facade over whatever provider plugins have registered an implementation of
that contract with `registry`. This is the task-owned-contract shape shared with `voiceover`:
providers depend on the contract type, and `translate` performs the single audited cast from the
registry's opaque `unknown` handler back to `TranslateHandler` at its own `resolve()` call site
(spec/09 R9).

The facade is deliberately the *direct* path: `generate()` resolves a handler and executes it
immediately, with no journaling, checkpointing, or retry. It exists for one-off translations,
scripts, and cost probing. Durable, resumable, progress-tracked execution of translate steps goes
through `app.runner.run()`, which drives the same registered handlers via build files. The plugin
is a stateless facade — no `state.ts`, no lifecycle hooks, no resources to start or stop.

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `defaultProvider` | `string` | `"openai"` | Provider used when a request doesn't name one. |

```ts
const app = createApp({
  pluginConfigs: { translate: { defaultProvider: "openai" } }
});
```

## The task contract (`contract.ts`)

Provider plugins implement this contract and register it with `registry` under the `"translate"`
task. Consumers can reach the types through the `Translate` namespace export of `@moku-labs/ai`.

```ts
type TranslateRequest = {
  text: string;
  targetLang: string; // BCP-47
  sourceLang?: string; // omitted = auto-detect
  model?: string;
  params?: Record<string, unknown>; // per-provider knobs
};

type TranslateResult = {
  text: string;
  detectedSourceLang?: string;
  costUsd: number;
  meta?: Record<string, unknown>; // token counts, model — metadata only
};

type TranslateHandler = {
  estimate(request: TranslateRequest): { usd: number };
  execute(request: TranslateRequest, opts: { signal?: AbortSignal }): Promise<TranslateResult>;
};
```

Every value resolved from the registry is runtime shape-guarded (function-typed `estimate` and
`execute` members) before the one audited cast to `TranslateHandler`. A registered value that
fails the guard throws:

```
[ai] Registered translate provider "<name>" does not implement TranslateHandler.
  It must expose estimate() and execute() functions.
```

## API reference (`app.translate.*`)

### `generate(request, opts?): Promise<TranslateResult>`

One-off direct translation. Resolves the configured (or requested) provider's handler from the
registry, shape-guards it, casts it (the plugin's one audited cast), and executes it immediately.
**NOT journaled** — this is the direct facade path; use `app.runner.run()` for the durable path.

- **`request: TranslateRequest`** — the text and target language, plus optional source language,
  model, and per-provider params.
- **`opts.provider?: string`** — provider override; defaults to `config.defaultProvider`.
- **`opts.signal?: AbortSignal`** — forwarded to the handler's `execute()` to cancel in flight.
- **Returns** `Promise<TranslateResult>` — translated text, cost in USD, and metadata.
- **Throws** when the resolved provider is unregistered or its registered value is malformed. An
  unregistered provider throws the pinned two-line error:

  ```
  [ai] No translate provider named "<name>" is registered.
    Available: <comma list or "none">.
  ```

```ts
const result = await app.translate.generate(
  { text: "Hello, world!", targetLang: "es" },
  { signal: controller.signal }
);
console.log(result.text, result.costUsd);
```

### `estimate(request, opts?): { usd: number }`

Cost estimate without executing. Resolves the provider exactly the way `generate()` does, then
calls the handler's `estimate()` instead of `execute()`. Synchronous.

- **`request: TranslateRequest`** — the request to price.
- **`opts.provider?: string`** — provider override; defaults to `config.defaultProvider`.
- **Returns** `{ usd: number }` — the estimated cost in USD.
- **Throws** the same unregistered/malformed provider errors as `generate()`.

```ts
const { usd } = app.translate.estimate({ text: "Hello, world!", targetLang: "es" });
```

### `providers(): string[]`

Provider names registered for the `"translate"` task, in registration order (the first registered
is the task default). Delegates to `registry.providers("translate")`.

```ts
const names = app.translate.providers(); // e.g. ["openai"]
```

## Events

None. The plugin emits nothing and listens to nothing — it is a pure request/response facade.

## Usage

```ts
import { createApp } from "@moku-labs/ai";
import type { Translate } from "@moku-labs/ai";

const app = createApp({
  pluginConfigs: { translate: { defaultProvider: "openai" } }
});
await app.start();

// Probe cost before committing.
const request: Translate.TranslateRequest = {
  text: "Hello, world!",
  targetLang: "es",
  sourceLang: "en"
};
const { usd } = app.translate.estimate(request);

// One-off direct translation (not journaled).
const result = await app.translate.generate(request);
console.log(result.text, result.detectedSourceLang, result.costUsd);

// Override the configured provider per call.
const alt = await app.translate.generate(request, { provider: "openai" });

// Cancelable.
const controller = new AbortController();
const pending = app.translate.generate(request, { signal: controller.signal });

await app.stop();
```

Authoring a custom provider from a Layer-3 app:

```ts
import { createPlugin, registryPlugin } from "@moku-labs/ai";
import type { Translate } from "@moku-labs/ai";

const echoHandler: Translate.TranslateHandler = {
  estimate: request => ({ usd: request.text.length * 0.00001 }),
  execute: async request => ({ text: request.text, costUsd: 0 })
};

const echoProvider = createPlugin("echoProvider", {
  depends: [registryPlugin],
  onInit: ctx => {
    ctx.require(registryPlugin).register("translate", "echo", echoHandler);
  }
});
```

## Integration

- **`registry` (dependency).** The plugin's only dependency, resolved via
  `ctx.require(registryPlugin)`. `generate()`/`estimate()` call
  `registry.resolve("translate", provider)`; `providers()` calls
  `registry.providers("translate")`. The registry stores handlers as opaque `unknown` values —
  `translate`, as the task owner, is the one place allowed to cast them back to
  `TranslateHandler`, guarded by a runtime shape check.
- **Provider plugins (fulfillers).** A provider plugin `import type`s `TranslateHandler` from
  `../translate/contract` and registers an implementation in its own `onInit`:
  `registry.register("translate", "<provider>", handler)`. In the framework, `openai` does this —
  it registers `createTranslateHandler(ctx)` under `("translate", "openai")`, pricing estimates
  from chat token heuristics and executing via the Chat Completions API. Registration order in
  `src/index.ts` puts providers after `translate`, so handlers are registered by the time the app
  starts.
- **`runner` (durable counterpart).** `app.translate.generate()` is the throwaway path; the same
  registered handlers are driven by `runner` for build-file execution with journaling, resume,
  and progress tracking.
