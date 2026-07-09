# promptGen

> Standard plugin — owns the prompt-gen capability contract + typed facade `app.promptGen.*` (minimal M0 scope; task key `"prompt-gen"`).

Deliberately MINIMAL at M0 (ratified user decision): contract + thin facade only — no packs, no
streaming, no advanced sampling controls. The `compose` plugin is the primary M0 consumer.
Task-owned-contract shape (same as `voiceover`/`translate`): `contract.ts` defines the contract
provider plugins implement and register with `registry` under the **kebab-case task key
`"prompt-gen"`** (the plugin/api name stays camelCase `promptGen`). `promptGen` performs the ONE
audited cast for this task at its own `resolve()` call site.

## Config

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `defaultProvider` | `string` | `"openai"` | Provider used when a request doesn't name one. |

## The contract

```ts
type PromptGenRequest = {
  prompt: string;
  system?: string;
  model?: string;
  temperature?: number; // provider maps/clamps as needed
  params?: Record<string, unknown>;
};
type PromptGenResult = {
  text: string;
  costUsd: number;
  meta?: Record<string, unknown>; // token counts, model — metadata only
};
type PromptGenHandler = {
  estimate(request: PromptGenRequest): { usd: number };
  execute(request: PromptGenRequest, opts: { signal?: AbortSignal }): Promise<PromptGenResult>;
};
```

Provider plugins `import type { PromptGenHandler } from "../promptGen/contract"` and register an
implementation with `registry` in their own `onInit`:

```ts
ctx.require(registryPlugin).register("prompt-gen", "openai", myPromptGenHandler);
```

## API

### `generate(request, opts?): Promise<PromptGenResult>`
One-off text generation — resolves the configured (or requested) provider, performs the plugin's
one audited cast to `PromptGenHandler`, and executes it immediately. **NOT journaled**: this is
the direct facade path, not the durable path — use `app.runner.run()` for resumable execution.

`opts.provider` overrides `config.defaultProvider`; `opts.signal` is forwarded to the handler.

An unregistered provider throws:
```
[ai] No prompt-gen provider named "<name>" is registered.
  Available: <comma list or "none">.
```

### `estimate(request, opts?): { usd: number }`
Cost estimate without executing — resolves the provider the same way `generate()` does, then
calls the handler's `estimate()` instead of `execute()`.

### `providers(): string[]`
Provider names registered for the `"prompt-gen"` task, in registration order (the first
registered is the task default).

## Events

None.

## Dependencies

- `registryPlugin` — `resolve("prompt-gen", provider)` and `providers("prompt-gen")`, both via
  `ctx.require(registryPlugin)`.

## Usage

```typescript
const app = createApp({
  pluginConfigs: { promptGen: { defaultProvider: "openai" } }
});

// Direct one-off generation
const result = await app.promptGen.generate({
  prompt: "Write a one-line tagline for a durable AI build system.",
  system: "You are a concise copywriter."
});

// Cost estimate without executing
const { usd } = app.promptGen.estimate({ prompt: "..." });

// Registered providers
const names = app.promptGen.providers();
```
