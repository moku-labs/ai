# registry

Dumb task→provider→handler transport for `@moku-labs/ai`. Providers register their
handlers in `onInit` via `ctx.require(registryPlugin)`; task plugins resolve a
handler and perform the ONE audited cast per task at their own call site
(spec/09 R9 genuine-dynamic-boundary — the open task set is a stated product
requirement). The registry itself never inspects, wraps, or types what it
transports.

**Tier:** Nano

## PERMANENT CONSTRAINT — registry must NEVER become a core plugin

It looks like "just a map" (structurally similar to `journal`/`store`/`limits`),
but provider registration requires `ctx.require(registryPlugin)` from `onInit`,
and `require`/`depends` are structurally unavailable in core-plugin context
(spec/11 §1.15–1.16) — a core plugin's context is `{ config, state }` only.
`registry` MUST stay a regular plugin (`createPlugin`, not `createCorePlugin`)
so provider plugins can declare `depends: [registryPlugin]` and register in
their own `onInit`. This constraint must survive every future refactor.

## Config

None.

## API

### `register(task: string, provider: string, handler: unknown): void`

Registers a handler for a `(task, provider)` pair. Throws on a duplicate
registration:

```
[ai] Provider "<provider>" is already registered for task "<task>".
  Register each task/provider pair exactly once.
```

### `resolve(task: string, provider: string): unknown`

Resolves a registered handler, or `undefined` if the pair is unregistered.
Returns `unknown` — narrowed by the calling task plugin at its own audited
cast site; the registry never inspects the handler shape.

### `providers(task: string): string[]`

Provider names registered for a task, in registration (insertion) order — the
first provider registered for a task is that task's default.

### `tasks(): string[]`

All registered task names, in registration order.

## Events

None — dumb transport by ratified decision; registration is silent.

## Dependencies

None — `registry` is the plugin others depend on.

## Usage

```typescript
import { registryPlugin } from "@moku-labs/ai";

// A provider plugin registers a handler in onInit:
export const elevenlabsPlugin = createPlugin("elevenlabs", {
  depends: [registryPlugin],
  onInit: ctx => {
    ctx.require(registryPlugin).register("voiceover", "elevenlabs", createVoiceoverHandler(ctx));
  }
});

// A task plugin resolves and performs its own audited cast:
export const voiceoverPlugin = createPlugin("voiceover", {
  depends: [registryPlugin],
  api: ctx => ({
    run: (provider: string, input: string) => {
      const handler = ctx.require(registryPlugin).resolve("voiceover", provider);
      if (typeof handler !== "function") {
        throw new Error(`[ai] No handler registered for voiceover/${provider}.`);
      }
      // ONE audited cast here — the open task set is a stated product requirement.
      return (handler as (input: string) => Promise<string>)(input);
    }
  })
});
```
