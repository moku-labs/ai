# translate

> Standard plugin — owns the translate capability contract + typed one-off facade `app.translate.*`.

Task-owned-contract shape (same as `voiceover`): `contract.ts` defines the `TranslateRequest` /
`TranslateResult` / `TranslateHandler` contract that provider plugins (`elevenlabs`, `openai`, ...)
implement and register with `registry` under the `"translate"` task. `translate` itself performs
the ONE audited cast for this task, at its own `resolve()` call site. No template packs at M0.

## Config

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `defaultProvider` | `string` | `"openai"` | Provider used when a request doesn't name one. |

## The contract

```ts
type TranslateRequest = {
  text: string;
  targetLang: string; // BCP-47
  sourceLang?: string; // omitted = auto-detect
  model?: string;
  params?: Record<string, unknown>;
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

Provider plugins `import type { TranslateHandler } from "../translate/contract"` and register an
implementation with `registry` in their own `onInit`:

```ts
ctx.require(registryPlugin).register("translate", "openai", myTranslateHandler);
```

## API

### `generate(request, opts?): Promise<TranslateResult>`
One-off direct translation — resolves the configured (or requested) provider, performs the
plugin's one audited cast to `TranslateHandler`, and executes it immediately. **NOT journaled**:
this is the direct facade path, not the durable path — use `app.runner.run()` for resumable,
progress-tracked execution.

`opts.provider` overrides `config.defaultProvider`; `opts.signal` is forwarded to the handler.

An unregistered provider throws:
```
[ai] No translate provider named "<name>" is registered.
  Available: <comma list or "none">.
```

### `estimate(request, opts?): { usd: number }`
Cost estimate without executing — resolves the provider the same way `generate()` does, then
calls the handler's `estimate()` instead of `execute()`.

### `providers(): string[]`
Provider names registered for the `"translate"` task, in registration order (the first
registered is the task default).

## Events

None.

## Dependencies

- `registryPlugin` — `resolve("translate", provider)` and `providers("translate")`, both via
  `ctx.require(registryPlugin)`.

## Usage

```typescript
const app = createApp({
  pluginConfigs: { translate: { defaultProvider: "openai" } }
});

// Direct one-off translation
const result = await app.translate.generate({ text: "Hello, world!", targetLang: "es" });

// Cost estimate without executing
const { usd } = app.translate.estimate({ text: "Hello, world!", targetLang: "es" });

// Registered providers
const names = app.translate.providers();
```
