# voiceover

> Owner of the "voiceover" task contract and the typed one-off facade `app.voiceover.*` — any registered provider, one audited cast, zero state.

## Purpose

`voiceover` is the task plugin for text-to-speech in the `@moku-labs/ai` build system. It owns the
capability contract (`contract.ts`) that every voiceover provider implements — `VoiceoverRequest`,
`VoiceoverResult`, and `VoiceoverHandler` — and exposes a small typed facade, `app.voiceover.*`,
for one-off generation, cost estimation, and provider discovery. Provider plugins (e.g.
`elevenlabs`, `openai`) implement `VoiceoverHandler` and register it with the `registry` plugin
under the `"voiceover"` task; this plugin resolves those handlers back out and dispatches to them.

The registry deliberately transports handlers as `unknown` (it never inspects what it carries), so
this plugin performs the ONE audited cast for the voiceover task (spec/09 R9): `api.ts` narrows
the opaque value back to `VoiceoverHandler` behind a runtime shape guard, at the single place that
knows the target type. A malformed registration therefore fails with a descriptive error, never a
crash. The plugin is a stateless facade — no `state.ts`, no lifecycle hooks, no events — and it
also bundles the M0 template packs (`packs/`) as versioned data modules.

## Configuration

Set under `pluginConfigs.voiceover` in `createApp`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultProvider` | `string` | `"elevenlabs"` | Provider used when a request doesn't name one via `opts.provider`. |
| `defaultFormat` | `"mp3" \| "wav" \| "ogg"` | `"mp3"` | Default output format hint applied when a request omits `format`. |

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({
  pluginConfigs: {
    voiceover: { defaultProvider: "openai", defaultFormat: "wav" }
  }
});
```

## The task contract (`contract.ts`)

The contract is self-contained by design — no shared base type is imported from elsewhere, so this
one file defines what a "voiceover provider" is. Provider plugins type-import it via
`import type { VoiceoverHandler } from "../voiceover/contract"` (a sanctioned cross-plugin sibling
import). Consumers get the same types from the package as `Voiceover.VoiceoverHandler` etc. (see
[Usage](#usage)).

### `VoiceoverRequest`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | `string` | yes | The text to synthesize. |
| `voice` | `string` | yes | Provider-scoped voice id or name (e.g. `"en-US-1"`, a provider's voice UUID). |
| `language` | `string` | no | BCP-47 language tag (e.g. `"en-US"`), for providers that need an explicit hint. |
| `model` | `string` | no | Provider-scoped model id (e.g. `"eleven_multilingual_v2"`). |
| `format` | `"mp3" \| "wav" \| "ogg"` | no | Output audio container format; defaulted from `config.defaultFormat` when omitted. |
| `params` | `Record<string, unknown>` | no | Resolved pack values merged upstream — providers receive final text/params only. |

### `VoiceoverResult`

| Field | Type | Description |
|-------|------|-------------|
| `audio` | `Uint8Array` | The synthesized audio bytes. |
| `mimeType` | `string` | MIME type of `audio` (`audio/mpeg` \| `audio/wav` \| `audio/ogg`). |
| `costUsd` | `number` | Actual cost of this generation, in US dollars. |
| `meta` | `Record<string, unknown>?` | Metadata only (e.g. `durationMs`, `characters`, `model`) — never a payload echo. |

### `VoiceoverHandler`

What a provider implements and registers with the registry under the `"voiceover"` task:

```ts
export type VoiceoverHandler = {
  /** Cost estimate without executing — used by the runner's budget gate and app.voiceover.estimate(). */
  estimate(request: VoiceoverRequest): { usd: number };
  /** Executes the request, returning the synthesized audio and its actual cost. */
  execute(request: VoiceoverRequest, opts: { signal?: AbortSignal }): Promise<VoiceoverResult>;
};
```

## API reference (`app.voiceover.*`)

### `generate(request, opts?): Promise<VoiceoverResult>`

One-off direct generation — resolves the named (or default) provider, performs the one audited
cast from the registry's opaque handler, and executes it.

**NOT journaled.** This bypasses the durable run ledger, so it has no resumability and no
cost-ledger entry. Prefer `app.runner.run()` for anything that needs resumability or durable cost
tracking; use `generate()` for scripts, tests, and interactive one-offs only.

| Param | Type | Description |
|-------|------|-------------|
| `request` | `VoiceoverRequest` | The voiceover request (text, voice, and optional params). |
| `opts.signal` | `AbortSignal?` | Optional abort signal to cancel the in-flight request. |
| `opts.provider` | `string?` | Provider override; defaults to `config.defaultProvider`. |

Returns `Promise<VoiceoverResult>`. Throws the pinned two-line error when the provider is
unregistered — or registered but structurally malformed:

```
[ai] No voiceover provider named "<name>" is registered.
  Available: <comma list or "none">.
```

```ts
const result = await app.voiceover.generate(
  { text: "Hello, world!", voice: "en-US-1" },
  { provider: "openai" }
);
await Bun.write("hello.mp3", result.audio);
```

Before dispatch, the request is resolved: `format` is defaulted from `config.defaultFormat` when
omitted, and the narration pack's per-provider defaults are merged under the request's own
`params` (request wins — see [Template packs](#template-packs-packs)).

### `estimate(request, opts?): { usd: number }`

Cost estimate without executing — delegates to the same handler `estimate()` the runner's budget
gate uses, so a one-off estimate and a runner budget check never disagree. The request goes
through the same format/pack resolution as `generate()`.

| Param | Type | Description |
|-------|------|-------------|
| `request` | `VoiceoverRequest` | The voiceover request to estimate. |
| `opts.provider` | `string?` | Provider override; defaults to `config.defaultProvider`. |

Returns `{ usd: number }`. Throws the same pinned two-line error for an unknown provider.

```ts
const { usd } = app.voiceover.estimate({ text: "Hello, world!", voice: "en-US-1" });
if (usd > 0.01) throw new Error("too expensive for a smoke test");
```

### `providers(): string[]`

Registered voiceover providers, in registration order (the first registered provider is the
task's implicit default at the registry level). Delegates to `registry.providers("voiceover")`.

```ts
app.voiceover.providers(); // => ["elevenlabs", "openai"]
```

### Module-level exports (not on `app.voiceover`)

`api.ts` also exports two symbols for testability — they are not re-exported on the package
surface:

- `mergePackParameters(pack, provider, requestParameters)` — the pack merge rule (ratified OQ5):
  `pack defaults -> request params`, request wins on key conflicts.
- `TemplatePack` — the structural type a versioned pack satisfies
  (`{ name; version; values: Record<provider, Record<string, unknown>> }`).

## Template packs (`packs/`)

Packs are versioned data modules, NOT plugins. They bundle per-provider param presets for a named
"look". M0 ships one pack:

```ts
// packs/narration.ts
export const narrationPack = {
  name: "narration",
  version: "1.0.0",
  values: {} // per-provider param presets keyed by provider name
} as const;
```

Both `generate()` and `estimate()` merge the pack's per-provider `values` under the request's own
`params` via `mergePackParameters` — the request always wins on conflicts. The pack `version`
participates in artifact identity: bump it whenever `values` changes so cached/journaled
artifacts invalidate correctly.

## Events

None. `voiceover` emits nothing and listens to nothing — one-off facade calls are deliberately
silent, and durable-run events (`item:queued`, etc.) belong to the `runner` plugin.

## Usage

```ts
import { createApp, Voiceover } from "@moku-labs/ai";

const app = createApp({
  pluginConfigs: { voiceover: { defaultProvider: "elevenlabs" } }
});
await app.start();

// One-off generation with the default provider.
const result = await app.voiceover.generate({
  text: "Welcome to the show.",
  voice: "en-US-1",
  language: "en-US"
});
console.log(result.mimeType, result.costUsd);

// Estimate first, override the provider, cancel on timeout.
const { usd } = app.voiceover.estimate({ text: "Long script…", voice: "alloy" }, { provider: "openai" });
const controller = new AbortController();
setTimeout(() => controller.abort(), 30_000);
const audio = await app.voiceover.generate(
  { text: "Long script…", voice: "alloy", format: "wav" },
  { provider: "openai", signal: controller.signal }
);

// Discover what's registered.
app.voiceover.providers(); // => ["elevenlabs", "openai"]

await app.stop();
```

Types are available under the `Voiceover` namespace re-export:

```ts
import type { Voiceover } from "@moku-labs/ai";

const request: Voiceover.VoiceoverRequest = { text: "Hi", voice: "en-US-1" };
type Handler = Voiceover.VoiceoverHandler;
type Config = Voiceover.Config;
```

## Integration

### registry (dependency)

`voiceover` declares `depends: [registryPlugin]` and reaches it via real
`ctx.require(registryPlugin)` calls — `resolve("voiceover", provider)` in `generate()`/
`estimate()` and `providers("voiceover")` in `providers()`. `RegistryApi` is declared once in
`registry/index.ts` (Nano tier, no `types.ts`); `types.ts` imports and re-exports it so the
dependency is fully typed inside the domain files.

### Provider plugins (elevenlabs, openai)

Providers fulfill the contract, not the other way around: in their `onInit`, `elevenlabsPlugin`
and `openaiPlugin` build a `VoiceoverHandler` and call
`ctx.require(registryPlugin).register("voiceover", "<name>", handler)`. This plugin never imports
a provider — the registry is the only coupling point, so new providers plug in without touching
`voiceover`. A Layer-3 custom provider works the same way:

```ts
import { createPlugin, registryPlugin } from "@moku-labs/ai";
import type { Voiceover } from "@moku-labs/ai";

const handler: Voiceover.VoiceoverHandler = {
  estimate: request => ({ usd: request.text.length * 0.00003 }),
  execute: async request => ({
    audio: await synthesize(request.text, request.voice),
    mimeType: "audio/mpeg",
    costUsd: 0.001
  })
};

export const acmeTtsPlugin = createPlugin("acmeTts", {
  depends: [registryPlugin],
  onInit: ctx => {
    ctx.require(registryPlugin).register("voiceover", "acme", handler);
  }
});
```

### runner (durable path)

`app.voiceover.generate()` and `app.runner.run()` dispatch to the same registered handlers, but
only the runner journals: durable runs get resumability, cost-ledger entries, and budget gating
via the same `handler.estimate()` this facade exposes. Rule of thumb — build files and anything
worth resuming go through `runner`; quick scripts, tests, and interactive experiments use
`app.voiceover.*` directly.
