/**
 * @file store core plugin — type definitions.
 */

/**
 * Store plugin configuration — root directory and hash algorithm for the
 * content-addressed store (CAS).
 *
 * @example
 * ```ts
 * const config: Config = { dir: ".moku/store", algo: "sha256" };
 * ```
 */
export type Config = {
  /** Root directory of the CAS. Default: ".moku/store". */
  dir: string;
  /** Hash algorithm (node:crypto). Fixed to "sha256" at M0; config exists for forward-compat. */
  algo: "sha256";
};

/**
 * Store plugin state — memoizes whether the CAS root directory has already
 * been verified/created, so repeated `put` calls skip redundant `mkdir`s.
 *
 * @example
 * ```ts
 * const state: State = { rootEnsured: false };
 * ```
 */
export type State = {
  /** Memoized "root dir verified/created" flag — lazy ensure on first write. */
  rootEnsured: boolean;
};

/**
 * Result of a successful `put` — the content's hash, its absolute path in
 * the CAS, and whether an object under that hash already existed
 * (first-committer-wins dedup).
 *
 * @example
 * ```ts
 * const result: PutResult = { hash: "ab12…", path: "/repo/.moku/store/ab/ab12…", existed: false };
 * ```
 */
export type PutResult = { hash: string; path: string; existed: boolean };

/**
 * Result of a `gc` sweep — how many objects were removed and how many bytes
 * were reclaimed.
 *
 * @example
 * ```ts
 * const result: GcResult = { removed: 2, bytesFreed: 4096 };
 * ```
 */
export type GcResult = { removed: number; bytesFreed: number };

/**
 * Public API surface injected as `ctx.store` on every regular plugin's context.
 *
 * @example
 * ```ts
 * const { hash } = await ctx.store.put(new TextEncoder().encode("hello"));
 * const bytes = await ctx.store.read(hash);
 * ```
 */
export type StoreApi = {
  /**
   * Write content; returns its hash + final path. No-op success if the hash
   * is already present (first-committer-wins). Follows
   * tmp→fsync(file)→rename→fsync(parent dir).
   *
   * @param content - Raw bytes to write.
   * @returns The content's hash, absolute path, and whether it already existed.
   * @example
   * ```ts
   * // runner, after a handler returns bytes: persist them before the journal points at them
   * await ctx.store.put(new TextEncoder().encode("hello"));
   * // { hash: "2cf24dba…", path: ".moku/store/2c/2cf24dba…", existed: false }
   * await ctx.store.put(new TextEncoder().encode("hello")); // same hash and path, existed: true
   * ```
   */
  put(content: Uint8Array): Promise<PutResult>;
  /**
   * Existence check by hash.
   *
   * @param hash - Content hash to look up.
   * @returns `true` if an object with this hash exists in the CAS.
   * @example
   * ```ts
   * // runner tryReuse(): reuse a journaled artifact only while its bytes are still in the store
   * const hit = ctx.journal.findDoneArtifact("ak-1");
   * if (hit && (await ctx.store.has(hit.contentHash))) ctx.journal.reuseDone(item.id, hit);
   * await ctx.store.has("0".repeat(64)); // false: well-formed, never written
   * await ctx.store.has("../etc/passwd"); // throws: malformed hash
   * ```
   */
  has(hash: string): Promise<boolean>;
  /**
   * Absolute path for a hash. Throws a not-found error if no object with
   * this hash exists.
   *
   * @param hash - Content hash to resolve.
   * @returns The absolute path of the stored object.
   * @example
   * ```ts
   * // runner export(): copy a done artifact to its named file without reading it into memory
   * const { hash } = await ctx.store.put(new TextEncoder().encode("hello"));
   * ctx.store.pathOf(hash); // ".moku/store/2c/2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
   * ctx.store.pathOf("0".repeat(64)); // throws "[ai] Store object not found for hash 000… …"
   * ```
   */
  pathOf(hash: string): string;
  /**
   * Read content by hash, re-verifying integrity by recomputing the hash
   * from disk. Throws if the object is missing or corrupt.
   *
   * @param hash - Content hash to read.
   * @returns The object's raw bytes.
   * @example
   * ```ts
   * // A plugin loads an artifact the journal recorded; the bytes are re-hashed on the way out
   * const { hash } = await ctx.store.put(new TextEncoder().encode("hello"));
   * new TextDecoder().decode(await ctx.store.read(hash)); // "hello"
   * // rejects "[ai] Store integrity check failed for <hash>. …" when the file on disk changed
   * ```
   */
  read(hash: string): Promise<Uint8Array>;
  /**
   * Compute the CAS hash of content without writing it (planning-time identity).
   *
   * @param content - Raw bytes to hash.
   * @returns The content's hash.
   * @example
   * ```ts
   * // Planning: know the CAS identity of bytes without writing them
   * ctx.store.hashOf(new TextEncoder().encode("hello"));
   * // "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824": the hash put() returns
   * ```
   */
  hashOf(content: Uint8Array): string;
  /**
   * Remove objects not referenced by the provided keep-set (driven by
   * `moku cache gc` reading the journal).
   *
   * @param keep - Set of hashes that must be preserved.
   * @returns The number of objects removed and total bytes freed.
   * @example
   * ```ts
   * // A cleanup plugin keeps every hash a done item points at and deletes the rest
   * const kept = await ctx.store.put(new TextEncoder().encode("keep"));
   * await ctx.store.put(new TextEncoder().encode("drop"));
   * await ctx.store.gc(new Set([kept.hash])); // { removed: 1, bytesFreed: 4 } in an otherwise empty store
   * ```
   */
  gc(keep: ReadonlySet<string>): Promise<GcResult>;
};
