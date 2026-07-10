# store

> Content-addressed artifact store (CAS) — crash-durable writes, integrity-verified reads, injected as `ctx.store`.

## Purpose

The store plugin is the framework's byte vault. Every raw artifact the build system generates — audio, text, any provider output — lands here as a content-addressed object on the local filesystem, keyed by its `sha256` hash. The journal plugin records only metadata plus hashes; the store holds the actual bytes. This split keeps the journal small and queryable while the store guarantees that a hash, once committed, always resolves to exactly the bytes it names. The store directory (`.moku/store` by default) is gitignored — raw content may embed prompts or PII and never enters version control.

The store's contract is "never lose a byte, never serve a wrong one." Writes follow a contractual durability protocol — write to a unique tmp file in the target shard directory, `fsync(file)`, `rename(tmp, final)`, `fsync(parent dir)` — so a crash at any point leaves either the complete object or an ignorable tmp file, never a torn final file. Because objects are named by their content hash, an already-present final path is a no-op success (first-committer-wins dedup: under a correct hash, identical hash implies identical content). Reads recompute the hash from disk on every call and refuse to return corrupt bytes.

It is a **Core plugin** (Standard tier), registered in `createCoreConfig` and injected as `ctx.store` on every regular plugin's context. It declares no events, no dependencies, and no lifecycle hooks.

## Storage layout

Objects live at `{dir}/{hash[0..2]}/{hash}` — a 2-hex-char shard prefix keeps any single directory from growing unboundedly:

```
.moku/store/
  ab/
    ab12…cd    ← object whose sha256 is ab12…cd
    .tmp-…     ← in-flight write (ignorable; cleaned up or renamed)
  ef/
    ef34…56
```

The root directory is created lazily on the first `put` (memoized via plugin state), so a read-only workload never touches the filesystem tree.

## Configuration

Set under the `store` key of `pluginConfigs`.

| Option | Type       | Default         | Description                                                                                  |
| ------ | ---------- | --------------- | -------------------------------------------------------------------------------------------- |
| `dir`  | `string`   | `".moku/store"` | Root directory of the CAS. Shards and objects are created beneath it.                        |
| `algo` | `"sha256"` | `"sha256"`      | Hash algorithm (`node:crypto`). Fixed to `"sha256"` at M0; the option exists for forward-compat. |

```ts
const app = createApp({
  pluginConfigs: {
    store: { dir: ".cache/artifacts", algo: "sha256" }
  }
});
```

## API reference (`ctx.store.*`)

All hashes are 64-character lowercase `sha256` hex digests. Every method that accepts a hash validates it first and throws on a malformed value (this also blocks path-traversal input like `"../../etc/passwd"` from ever reaching path construction).

### `put(content: Uint8Array): Promise<PutResult>`

Writes content to the CAS using the durable protocol (tmp → `fsync(file)` → `rename` → `fsync(parent dir)`).

- **Params:** `content` — raw bytes to write.
- **Returns:** `{ hash: string; path: string; existed: boolean }` — the content's hash, its absolute path in the CAS, and whether an object under that hash already existed. When `existed` is `true` no bytes were rewritten (first-committer-wins). A concurrent `EEXIST` on rename is likewise treated as success.
- **Throws:** propagates filesystem errors (leftover tmp files are cleaned up best-effort).

```ts
const { hash, path, existed } = await ctx.store.put(new TextEncoder().encode("hello"));
```

### `has(hash: string): Promise<boolean>`

Existence check by hash.

- **Params:** `hash` — content hash to look up.
- **Returns:** `true` if an object with this hash exists in the CAS.
- **Throws:** on a malformed hash.

```ts
if (await ctx.store.has(hash)) { /* skip regeneration */ }
```

### `pathOf(hash: string): string`

Resolves the absolute path of a stored object. Synchronous — useful for handing a file path to an external process without reading the bytes.

- **Params:** `hash` — content hash to resolve.
- **Returns:** the absolute path of the stored object.
- **Throws:** on a malformed hash, or a not-found error if no object with this hash exists:
  `[ai] Store object not found for hash <hash>.`

```ts
const audioPath = ctx.store.pathOf(contentHash);
```

### `read(hash: string): Promise<Uint8Array>`

Reads content by hash and **re-verifies integrity** by recomputing the hash from the bytes on disk.

- **Params:** `hash` — content hash to read.
- **Returns:** the object's raw bytes.
- **Throws:** on a malformed hash; a not-found error if the object is missing; or, on hash mismatch:
  `[ai] Store integrity check failed for <hash>.` — the artifact is corrupt; delete it and re-run to regenerate.

```ts
const bytes = await ctx.store.read(hash);
```

### `hashOf(content: Uint8Array): string`

Computes the CAS hash of content without writing it — planning-time identity, e.g. to decide whether work can be skipped before generating anything.

- **Params:** `content` — raw bytes to hash.
- **Returns:** the content's `sha256` hex digest.

```ts
const wouldBe = ctx.store.hashOf(candidateBytes);
```

### `gc(keep: ReadonlySet<string>): Promise<GcResult>`

Sweeps the CAS and removes every object whose hash is not in the keep-set. In-flight `.tmp-` files are never touched, and a missing store root is a no-op. Designed to be driven by a cache-gc flow that derives the keep-set from the journal's live artifact hashes.

- **Params:** `keep` — set of hashes that must be preserved.
- **Returns:** `{ removed: number; bytesFreed: number }` — objects removed and total bytes reclaimed.

```ts
const { removed, bytesFreed } = await ctx.store.gc(new Set(liveHashes));
```

## Events

None. The store emits no events and listens to none — it is a pure API surface (core plugins in this framework expose `ctx.*` APIs; event traffic belongs to regular plugins such as the runner).

## Usage examples

### Consuming `ctx.store` from a custom Layer-3 plugin

```ts
import { createApp, createPlugin } from "@moku-labs/ai";

const snapshotPlugin = createPlugin("snapshot", {
  api: ctx => ({
    /** Persist a payload and return its durable identity. */
    save: async (payload: Uint8Array) => {
      const { hash, existed } = await ctx.store.put(payload);
      if (existed) ctx.log.info("snapshot deduped", { hash });
      return hash;
    },
    /** Load a payload back, integrity-verified. */
    load: (hash: string) => ctx.store.read(hash)
  })
});

const app = createApp({ plugins: [snapshotPlugin] });
await app.start();
```

### Skip-if-present with planning-time hashing

```ts
const hash = ctx.store.hashOf(renderedBytes);

if (!(await ctx.store.has(hash))) {
  await ctx.store.put(renderedBytes);
}

const onDiskPath = ctx.store.pathOf(hash);
```

### Overriding the store directory in a consumer app

```ts
import { createApp } from "@moku-labs/ai";

const app = createApp({
  pluginConfigs: {
    store: { dir: "/var/cache/moku-store", algo: "sha256" }
  }
});
```

## Integration

- **journal** — the two plugins split one responsibility: the journal persists item metadata and `contentHash` references; the store persists the bytes those hashes name. An artifact is fully committed only when both halves exist.
- **runner** — the primary consumer. After a handler attempt succeeds, the runner's persist step calls `ctx.store.put(result.body)` and then records the returned hash in the journal via `ctx.journal.commitDone(itemId, { contentHash, … })`. Because `put` is fsync-durable when it resolves, a journal row never references bytes that could vanish in a crash.
- **gc keep-sets** — `gc(keep)` expects its keep-set to be derived from journal state (the hashes of all live artifacts); anything unreferenced is swept.
- **Depends on** — nothing. `node:crypto`, `node:fs`/`node:fs/promises`, and `node:path` only; no other plugins, no lifecycle hooks (`onInit`/`onStart`/`onStop` intentionally unused — every operation is a self-contained filesystem call and every `put` is durable at resolve time).

## Files

| File       | Role                                                                       |
| ---------- | -------------------------------------------------------------------------- |
| `index.ts` | `storePlugin` — `createCorePlugin("store", …)` wiring config, state, API.  |
| `types.ts` | `Config`, `State`, `PutResult`, `GcResult`, `StoreApi`.                    |
| `state.ts` | `createStoreState()` — initial `{ rootEnsured: false }`.                   |
| `api.ts`   | `createStoreApi()` — the CAS operations and the durable write protocol.    |
