# registry

The dumb task→provider→handler transport at the heart of `@moku-labs/ai`.

## Purpose

`registry` is a two-level in-memory map — task name → provider name → handler — that
decouples *task* plugins (which own a capability contract, e.g. `voiceover`) from
*provider* plugins (which implement it, e.g. `elevenlabs`). Provider plugins register
their handlers during `onInit` via `ctx.require(registryPlugin)`; task plugins and the
runner resolve handlers at call time. Handlers are stored and returned as `unknown` —
the registry never inspects, wraps, or types what it transports. Each task plugin
performs its ONE audited cast at its own `resolve()` call site (spec/09 R9
genuine-dynamic-boundary — the open task set is a stated product requirement).

Because any provider can serve any task and consumer apps can add both, the registry
is what makes the framework's "any task × any provider" promise composable: no task
plugin imports a provider, and no provider imports a task's API — they meet only
through this map and the task's contract types.

**Tier:** Nano — all logic inline in `index.ts`.

## PERMANENT CONSTRAINT — registry must NEVER become a core plugin

It looks like "just a map" (structurally similar to `journal`/`store`/`limits`), but
provider registration requires `ctx.require(registryPlugin)` from `onInit`, and
`require`/`depends` are structurally unavailable in core-plugin context
(spec/11 §1.15–1.16) — a core plugin's context is `{ config, state }` only.
`registry` MUST stay a regular plugin (`createPlugin`, not a core plugin in
`createCoreConfig`) so provider plugins can declare `depends: [registryPlugin]` and
register in their own `onInit`. This constraint must survive every future refactor.

## Configuration

None. The plugin takes no config options; its state is an empty
`Map<string, Map<string, unknown>>` created by `createState`.

## API reference

Available as `app.registry.*` on a started app, or `ctx.require(registryPlugin)`
inside a plugin that declares `depends: [registryPlugin]`.

### `register(task: string, provider: string, handler: unknown): void`

Registers a handler for a `(task, provider)` pair.

- **Params:** `task` — task key (e.g. `"voiceover"`); `provider` — provider name
  (e.g. `"elevenlabs"`); `handler` — opaque handler, narrowed later by the owning
  task plugin.
- **Returns:** nothing.
- **Throws:** `Error` on duplicate registration, with the exact message:

  ```
  [ai] Provider "<provider>" is already registered for task "<task>".
    Register each task/provider pair exactly once.
  ```

```ts
ctx.require(registryPlugin).register("voiceover", "elevenlabs", createVoiceoverHandler(ctx));
```

### `resolve(task: string, provider: string): unknown`

Resolves a registered handler.

- **Params:** `task` — task key; `provider` — provider name.
- **Returns:** the registered handler as `unknown` (never `any`), or `undefined`
  when the pair is unregistered. Callers guard and narrow at their own audited
  cast site.
- **Throws:** never.

```ts
const handler = ctx.require(registryPlugin).resolve("voiceover", "elevenlabs");
```

### `providers(task: string): string[]`

Provider names registered for a task, in registration (insertion) order. The first
provider registered for a task is that task's default — the runner uses
`providers(task)[0]` when a build item names no provider.

- **Params:** `task` — task key.
- **Returns:** provider names, first-registered first; `[]` for an unknown task.
- **Throws:** never.

```ts
app.registry.providers("voiceover"); // ["elevenlabs", "openai"]
```

### `tasks(): string[]`

All registered task names, in registration order.

- **Returns:** task keys; `[]` when nothing is registered.
- **Throws:** never.

```ts
app.registry.tasks(); // ["voiceover", "translate", "prompt-gen"]
```

## Events

None — dumb transport by ratified decision. It emits nothing, listens to nothing,
and registration is silent.

## Usage examples

A provider plugin registers its handlers in `onInit` (this is exactly how the
built-in `elevenlabs` and `openai` plugins work):

```ts
import { createPlugin, registryPlugin } from "@moku-labs/ai";

export const myProviderPlugin = createPlugin("myProvider", {
  depends: [registryPlugin],
  onInit: ctx => {
    const registry = ctx.require(registryPlugin);
    registry.register("voiceover", "myProvider", createVoiceoverHandler(ctx));
    registry.register("translate", "myProvider", createTranslateHandler(ctx));
  }
});
```

A task plugin resolves, guards, and performs its single audited cast:

```ts
import { createPlugin, registryPlugin } from "@moku-labs/ai";

export const myTaskPlugin = createPlugin("myTask", {
  depends: [registryPlugin],
  api: ctx => ({
    run: (provider: string, input: string) => {
      const registry = ctx.require(registryPlugin);
      const handler = registry.resolve("myTask", provider);
      if (typeof handler !== "function") {
        throw new Error(`[ai] No handler registered for myTask/${provider}.`);
      }
      // ONE audited cast — registry.resolve() returns unknown by design.
      return (handler as (input: string) => Promise<string>)(input);
    },
    providers: () => registryDefaultsFirst(ctx)
  })
});
```

Inspecting the registry from a consumer app:

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({});
await app.start();

app.registry.tasks(); // ["voiceover", "translate", "prompt-gen"]
app.registry.providers("voiceover"); // first entry = default provider
```

## Integration

Registered first in the framework's plugin list (`src/index.ts`) so every dependent
appears after it. In-repo consumers:

- **elevenlabs** (provider) — `onInit` registers `("voiceover", "elevenlabs")`.
- **openai** (provider) — `onInit` registers `("voiceover", "openai")`,
  `("translate", "openai")`, and `("prompt-gen", "openai")`.
- **voiceover / translate / promptGen** (task facades) — `resolve()` their task's
  handler, guard against `undefined`, cast once against the task-owned contract in
  `contract.ts`, and expose `providers()` on their own API (e.g.
  `app.translate.providers()`); unknown providers raise an error listing what IS
  registered.
- **runner** — during planning uses `providers(task)[0]` as the default provider for
  build items that name none (erroring when the list is empty), and during pipeline
  execution `resolve()`s the handler for each work item.

Task keys are plain strings owned by the task plugins (`"voiceover"`,
`"translate"`, `"prompt-gen"`); the registry imposes no naming scheme, which is what
keeps the task set open to Layer-3 consumer plugins.
