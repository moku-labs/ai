# voiceover

> Standard plugin — owns the voiceover capability contract + typed one-off facade `app.voiceover.*` + M0 template packs

Owns the "voiceover" task's capability contract (`contract.ts`) that provider plugins implement and
register with `registry`, exposes a typed one-off facade over that registry (`app.voiceover.*`),
and bundles the M0 template packs as versioned data modules (`packs/`). Performs the ONE audited
cast for the "voiceover" task at its `resolve()` call site (spec/09 R9 — narrowing `unknown` from
the registry at the one place that knows the target type).

## Config

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `defaultProvider` | `string` | `"elevenlabs"` | Provider used when a request doesn't name one. |
| `defaultFormat` | `"mp3" \| "wav" \| "ogg"` | `"mp3"` | Default output format hint passed to providers. |

## The contract (`contract.ts`)

```ts
type VoiceoverRequest = {
  text: string;
  voice: string;                    // provider-scoped voice id/name
  language?: string;                // BCP-47
  model?: string;                   // provider-scoped model id
  format?: "mp3" | "wav" | "ogg";
  params?: Record<string, unknown>; // resolved pack values merged upstream
};
type VoiceoverResult = {
  audio: Uint8Array;
  mimeType: string;                 // audio/mpeg | audio/wav | audio/ogg
  costUsd: number;
  meta?: Record<string, unknown>;   // metadata only, never a payload echo
};
type VoiceoverHandler = {
  estimate(req: VoiceoverRequest): { usd: number };
  execute(req: VoiceoverRequest, opts: { signal?: AbortSignal }): Promise<VoiceoverResult>;
};
```

Self-contained by design: no shared base type is imported from elsewhere. Provider plugins
type-import it via `import type { VoiceoverHandler } from "../voiceover/contract"`.

## API

### `generate(request, opts?): Promise<VoiceoverResult>`
One-off direct generation — resolves `opts?.provider ?? config.defaultProvider`, performs the one
audited cast from the registry's opaque handler, and executes it. **NOT journaled**: this bypasses
the durable run ledger and has no resumability or cost-ledger entry. Prefer `app.runner.run()` for
anything that needs resumability or durable cost tracking; use `generate()` for scripts, tests, and
interactive one-offs only.

Unknown provider throws:
```
[ai] No voiceover provider named "<name>" is registered.
  Available: <comma list or "none">.
```

### `estimate(request, opts?): { usd: number }`
Cost estimate without executing — calls the same handler `estimate()` the runner's budget gate
uses, so a one-off estimate and a runner budget check never disagree.

### `providers(): string[]`
Registered voiceover providers, in registration order (`registry.providers("voiceover")`).

## Template packs (`packs/`)

Versioned data modules, NOT plugins:

```ts
// packs/narration.ts — the M0 pack
export const narrationPack = {
  name: "narration",
  version: "1.0.0",
  values: {} // per-provider param presets keyed by provider name
} as const;
```

`generate()`/`estimate()` merge `narrationPack`'s per-provider defaults under the request's own
`params` (request wins — ratified OQ5) via a plain internal function in `api.ts`. Pack `version`
participates in artifact identity.

## Events

None.

## Dependencies

`registry` — `resolve("voiceover", provider)` and `providers("voiceover")`, both via real
`ctx.require(registryPlugin)` calls.

## Usage

```typescript
import { createApp } from "@moku-labs/ai";

const app = createApp({
  pluginConfigs: { voiceover: { defaultProvider: "elevenlabs" } }
});
await app.start();

const result = await app.voiceover.generate({ text: "Hello, world!", voice: "en-US-1" });
const { usd } = app.voiceover.estimate({ text: "Hello, world!", voice: "en-US-1" });
app.voiceover.providers(); // => ["elevenlabs", ...]
```
