# store

> Core·Standard plugin — content-addressed artifact store (tmp→fsync→rename→fsync(dir), integrity re-verify)

Holds all raw generated content (audio, text artifacts) on the local filesystem, addressed by
`sha256` hash. The journal holds only metadata + hashes; the store holds the bytes. Layout is
hash-prefix-sharded: `{dir}/{hash[0..2]}/{hash}`. Writes are crash-durable
(tmp file in the same shard dir → fsync(file) → rename → fsync(parent dir)); an existing final
path is treated as a no-op success (first-committer-wins dedup, since identical hash implies
identical content). Reads re-verify integrity by recomputing the hash on every call.

Injected as `ctx.store` on every regular plugin's context. The store directory (`.moku/store` by
default) is gitignored.

## API

- `put(content: Uint8Array): Promise<{ hash, path, existed }>` — writes content, returns its hash
  and final path; `existed: true` if the hash was already present (no bytes rewritten).
- `has(hash: string): Promise<boolean>` — existence check by hash.
- `pathOf(hash: string): string` — absolute path for a hash; throws a not-found error if the hash
  has never been written.
- `read(hash: string): Promise<Uint8Array>` — reads and re-verifies integrity; throws if the
  object is missing or the recomputed hash doesn't match (corruption).
- `hashOf(content: Uint8Array): string` — computes the CAS hash without writing (planning-time
  identity check).
- `gc(keep: ReadonlySet<string>): Promise<{ removed, bytesFreed }>` — removes every object whose
  hash is not in `keep` (driven by `moku cache gc` reading the journal).

## Configuration

```ts
type Config = {
  /** Root directory of the CAS. Default: ".moku/store". */
  dir: string;
  /** Hash algorithm (node:crypto). Fixed to "sha256" at M0; config exists for forward-compat. */
  algo: "sha256";
};
```

Override via the core plugin config cascade, e.g. in `createCoreConfig`:

```ts
createCoreConfig("ai", {
  config: {},
  plugins: [storePlugin],
  pluginConfigs: { store: { dir: ".moku/store", algo: "sha256" } }
});
```

## Lifecycle

None — `onInit`/`onStart`/`onStop` are intentionally unused. CAS operations are per-call
filesystem operations with no persistent handle; the root directory is ensured lazily on the
first `put` (memoized via `state.rootEnsured`). Every `put` is already fsync-durable when it
resolves.
