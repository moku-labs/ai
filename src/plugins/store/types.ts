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
   */
  put(content: Uint8Array): Promise<PutResult>;
  /**
   * Existence check by hash.
   *
   * @param hash - Content hash to look up.
   * @returns `true` if an object with this hash exists in the CAS.
   */
  has(hash: string): Promise<boolean>;
  /**
   * Absolute path for a hash. Throws a not-found error if no object with
   * this hash exists.
   *
   * @param hash - Content hash to resolve.
   * @returns The absolute path of the stored object.
   */
  pathOf(hash: string): string;
  /**
   * Read content by hash, re-verifying integrity by recomputing the hash
   * from disk. Throws if the object is missing or corrupt.
   *
   * @param hash - Content hash to read.
   * @returns The object's raw bytes.
   */
  read(hash: string): Promise<Uint8Array>;
  /**
   * Compute the CAS hash of content without writing it (planning-time identity).
   *
   * @param content - Raw bytes to hash.
   * @returns The content's hash.
   */
  hashOf(content: Uint8Array): string;
  /**
   * Remove objects not referenced by the provided keep-set (driven by
   * `moku cache gc` reading the journal).
   *
   * @param keep - Set of hashes that must be preserved.
   * @returns The number of objects removed and total bytes freed.
   */
  gc(keep: ReadonlySet<string>): Promise<GcResult>;
};
