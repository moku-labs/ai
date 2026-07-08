/**
 * @file store core plugin — API factory: content-addressed CAS operations.
 *
 * Write protocol (contractual, do not weaken): write to a unique tmp file in
 * the same shard directory → fsync(file) → rename(tmp, final) →
 * fsync(parent dir). An existing final path is a no-op success — under a
 * correct hash, content is identical by definition (first-committer-wins).
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { Config, GcResult, PutResult, State, StoreApi } from "./types";

const SHARD_PREFIX_LENGTH = 2;
const HASH_ALGORITHM = "sha256";
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Core plugin context available to store domain helpers (config + state only).
 *
 * @example
 * ```ts
 * const context: StoreContext = { config: { dir: ".moku/store", algo: "sha256" }, state: { rootEnsured: false } };
 * ```
 */
type StoreContext = {
  readonly config: Readonly<Config>;
  readonly state: State;
};

/**
 * Derives the shard directory for a hash (first two hex chars).
 *
 * @param root - CAS root directory.
 * @param hash - Content hash.
 * @returns Absolute shard directory path.
 * @example
 * ```ts
 * shardDirectoryFor(".moku/store", "ab12cd"); // => ".moku/store/ab"
 * ```
 */
function shardDirectoryFor(root: string, hash: string): string {
  return path.join(root, hash.slice(0, SHARD_PREFIX_LENGTH));
}

/**
 * Derives the final object path for a hash.
 *
 * @param root - CAS root directory.
 * @param hash - Content hash.
 * @returns Absolute final object path.
 * @example
 * ```ts
 * finalPathFor(".moku/store", "ab12cd"); // => ".moku/store/ab/ab12cd"
 * ```
 */
function finalPathFor(root: string, hash: string): string {
  return path.join(shardDirectoryFor(root, hash), hash);
}

/**
 * Computes the CAS hash of content.
 *
 * @param content - Raw bytes to hash.
 * @returns Hex-encoded hash digest.
 * @example
 * ```ts
 * const hash = hashOfContent(new TextEncoder().encode("hi"));
 * ```
 */
function hashOfContent(content: Uint8Array): string {
  return createHash(HASH_ALGORITHM).update(content).digest("hex");
}

/**
 * Type guard for Node's errno-carrying error shape.
 *
 * @param error - Unknown value caught from a filesystem call.
 * @returns Whether the error carries a `code` string (e.g. `ENOENT`, `EEXIST`).
 * @example
 * ```ts
 * try {
 *   await stat(target);
 * } catch (error) {
 *   if (isErrnoException(error) && error.code === "ENOENT") return false;
 *   throw error;
 * }
 * ```
 */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/**
 * Checks whether a filesystem path exists.
 *
 * @param target - Absolute path to check.
 * @returns `true` if the path exists.
 * @example
 * ```ts
 * const found = await pathExists("/tmp/x");
 * ```
 */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Fsyncs a file or directory by path.
 *
 * @param target - Absolute path to fsync.
 * @returns Resolves once the fsync completes.
 * @example
 * ```ts
 * await fsyncPath(shardDirectory);
 * ```
 */
async function fsyncPath(target: string): Promise<void> {
  const handle = await open(target, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Lazily ensures the CAS root directory exists, memoized on state.
 *
 * @param context - Store context (config + state).
 * @returns Resolves once the root directory is ensured.
 * @example
 * ```ts
 * await ensureRoot(context);
 * ```
 */
async function ensureRoot(context: StoreContext): Promise<void> {
  if (context.state.rootEnsured) return;
  await mkdir(context.config.dir, { recursive: true });
  context.state.rootEnsured = true;
}

/**
 * Validates that a caller-supplied hash is a well-formed sha256 hex digest
 * BEFORE it participates in any path construction. Without this guard a
 * value like `"../../../etc/passwd"` would escape the CAS root entirely.
 *
 * @param hash - Caller-supplied hash to validate.
 * @throws {Error} Two-line-formatted error when the hash is not 64 lowercase hex chars.
 * @example
 * ```ts
 * assertValidHash(hash);
 * ```
 */
function assertValidHash(hash: string): void {
  if (SHA256_HEX_PATTERN.test(hash)) return;
  throw new Error(
    `[ai] Store received a malformed hash "${hash}".\n  Expected a 64-character lowercase sha256 hex digest.`
  );
}

/**
 * Builds the two-line not-found error for a missing hash.
 *
 * @param hash - Content hash that could not be located.
 * @returns The formatted error.
 * @example
 * ```ts
 * throw notFoundError(hash);
 * ```
 */
function notFoundError(hash: string): Error {
  return new Error(
    `[ai] Store object not found for hash ${hash}.\n  Verify the hash is correct, or call put() to write the content first.`
  );
}

/**
 * Builds the two-line integrity-failure error for a corrupt object.
 *
 * @param hash - Expected content hash.
 * @returns The formatted error.
 * @example
 * ```ts
 * throw integrityError(hash);
 * ```
 */
function integrityError(hash: string): Error {
  return new Error(
    `[ai] Store integrity check failed for ${hash}.\n  The artifact is corrupt; delete it and re-run to regenerate.`
  );
}

/**
 * Best-effort cleanup of a leftover tmp file — errors are swallowed since
 * this only runs after a failure we are already propagating.
 *
 * @param temporaryPath - Path of the tmp file to remove.
 * @returns Resolves once the cleanup attempt completes.
 * @example
 * ```ts
 * await cleanupTemporaryFile(temporaryPath);
 * ```
 */
async function cleanupTemporaryFile(temporaryPath: string): Promise<void> {
  try {
    await unlink(temporaryPath);
  } catch {
    // Best-effort — the rename already failed; nothing more to do here.
  }
}

/**
 * Writes content to a unique tmp file in the target shard directory,
 * fsyncs it, then renames it into place and fsyncs the shard directory.
 * An EEXIST on rename is treated as a no-op success (identical content
 * under a correct hash).
 *
 * @param shardDirectory - Shard directory that will hold the final object.
 * @param finalPath - Final object path.
 * @param content - Raw bytes to write.
 * @returns Resolves once the durable write completes.
 * @example
 * ```ts
 * await writeDurable(shardDirectory, finalPath, content);
 * ```
 */
async function writeDurable(
  shardDirectory: string,
  finalPath: string,
  content: Uint8Array
): Promise<void> {
  await mkdir(shardDirectory, { recursive: true });
  const temporaryPath = path.join(shardDirectory, `.tmp-${randomBytes(16).toString("hex")}`);

  const handle = await open(temporaryPath, "w");
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporaryPath, finalPath);
  } catch (error) {
    await cleanupTemporaryFile(temporaryPath);
    if (isErrnoException(error) && error.code === "EEXIST") return;
    throw error;
  }

  await fsyncPath(shardDirectory);
}

/**
 * Removes hashes not present in the keep-set from a single shard directory.
 *
 * @param shardDirectory - Absolute shard directory path.
 * @param keep - Set of hashes that must be preserved.
 * @returns The number of objects removed and bytes freed from this shard.
 * @example
 * ```ts
 * const result = await gcShard(shardDirectory, keep);
 * ```
 */
async function gcShard(shardDirectory: string, keep: ReadonlySet<string>): Promise<GcResult> {
  const entries = await readdir(shardDirectory);
  let removed = 0;
  let bytesFreed = 0;

  for (const entry of entries) {
    if (keep.has(entry) || entry.startsWith(".tmp-")) continue;
    const objectPath = path.join(shardDirectory, entry);
    const objectStat = await stat(objectPath);
    await unlink(objectPath);
    removed += 1;
    bytesFreed += objectStat.size;
  }

  return { removed, bytesFreed };
}

/**
 * Resolves the absolute path for a hash, throwing if the object is missing.
 *
 * @param context - Store context (config + state).
 * @param hash - Content hash to resolve.
 * @returns The absolute path of the stored object.
 * @example
 * ```ts
 * const objectPath = pathOf(context, hash);
 * ```
 */
function pathOf(context: StoreContext, hash: string): string {
  assertValidHash(hash);
  const finalPath = finalPathFor(context.config.dir, hash);
  if (!existsSync(finalPath)) throw notFoundError(hash);
  return finalPath;
}

/**
 * Checks whether an object with the given hash exists in the CAS.
 *
 * @param context - Store context (config + state).
 * @param hash - Content hash to look up.
 * @returns `true` if an object with this hash exists.
 * @example
 * ```ts
 * const found = await has(context, hash);
 * ```
 */
async function has(context: StoreContext, hash: string): Promise<boolean> {
  assertValidHash(hash);
  return pathExists(finalPathFor(context.config.dir, hash));
}

/**
 * Writes content to the CAS, deduping on hash (first-committer-wins).
 *
 * @param context - Store context (config + state).
 * @param content - Raw bytes to write.
 * @returns The content's hash, absolute path, and whether it already existed.
 * @example
 * ```ts
 * const result = await put(context, content);
 * ```
 */
async function put(context: StoreContext, content: Uint8Array): Promise<PutResult> {
  const hash = hashOfContent(content);
  const finalPath = finalPathFor(context.config.dir, hash);

  if (await pathExists(finalPath)) {
    return { hash, path: finalPath, existed: true };
  }

  await ensureRoot(context);
  await writeDurable(shardDirectoryFor(context.config.dir, hash), finalPath, content);
  return { hash, path: finalPath, existed: false };
}

/**
 * Reads content by hash, re-verifying integrity against the recomputed hash.
 *
 * @param context - Store context (config + state).
 * @param hash - Content hash to read.
 * @returns The object's raw bytes.
 * @example
 * ```ts
 * const bytes = await read(context, hash);
 * ```
 */
async function read(context: StoreContext, hash: string): Promise<Uint8Array> {
  assertValidHash(hash);
  const finalPath = finalPathFor(context.config.dir, hash);
  if (!(await pathExists(finalPath))) throw notFoundError(hash);

  const handle = await open(finalPath, "r");
  let content: Uint8Array;
  try {
    content = new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }

  if (hashOfContent(content) !== hash) throw integrityError(hash);
  return content;
}

/**
 * Sweeps the CAS, removing every object whose hash is not in the keep-set.
 *
 * @param context - Store context (config + state).
 * @param keep - Set of hashes that must be preserved.
 * @returns The number of objects removed and total bytes freed.
 * @example
 * ```ts
 * const result = await gc(context, keep);
 * ```
 */
async function gc(context: StoreContext, keep: ReadonlySet<string>): Promise<GcResult> {
  if (!(await pathExists(context.config.dir))) return { removed: 0, bytesFreed: 0 };

  const shardNames = await readdir(context.config.dir);
  let removed = 0;
  let bytesFreed = 0;

  for (const shardName of shardNames) {
    const shardDirectory = path.join(context.config.dir, shardName);
    const shardStat = await stat(shardDirectory);
    if (!shardStat.isDirectory()) continue;

    const shardResult = await gcShard(shardDirectory, keep);
    removed += shardResult.removed;
    bytesFreed += shardResult.bytesFreed;
  }

  return { removed, bytesFreed };
}

/**
 * Creates the store API surface (ctx.store.*).
 *
 * @param context - Core plugin context (config + state).
 * @param context.config - Resolved store configuration.
 * @param context.state - Store state (root-ensured flag).
 * @returns The store API, injected as `ctx.store` on every regular plugin.
 * @example
 * ```ts
 * const api = createStoreApi({ config, state });
 * ```
 */
export function createStoreApi(context: StoreContext): StoreApi {
  /**
   * Writes content to the CAS, bound to this API's store context.
   *
   * @param content - Raw bytes to write.
   * @returns The content's hash, absolute path, and whether it already existed.
   * @example
   * ```ts
   * const result = await api.put(content);
   * ```
   */
  const boundPut = (content: Uint8Array): Promise<PutResult> => put(context, content);

  /**
   * Existence check by hash, bound to this API's store context.
   *
   * @param hash - Content hash to look up.
   * @returns `true` if an object with this hash exists.
   * @example
   * ```ts
   * const found = await api.has(hash);
   * ```
   */
  const boundHas = (hash: string): Promise<boolean> => has(context, hash);

  /**
   * Resolves the absolute path for a hash, bound to this API's store context.
   *
   * @param hash - Content hash to resolve.
   * @returns The absolute path of the stored object.
   * @example
   * ```ts
   * const objectPath = api.pathOf(hash);
   * ```
   */
  const boundPathOf = (hash: string): string => pathOf(context, hash);

  /**
   * Reads content by hash, re-verifying integrity, bound to this API's store context.
   *
   * @param hash - Content hash to read.
   * @returns The object's raw bytes.
   * @example
   * ```ts
   * const bytes = await api.read(hash);
   * ```
   */
  const boundRead = (hash: string): Promise<Uint8Array> => read(context, hash);

  /**
   * Sweeps the CAS, removing objects not in the keep-set, bound to this API's store context.
   *
   * @param keep - Set of hashes that must be preserved.
   * @returns The number of objects removed and total bytes freed.
   * @example
   * ```ts
   * const result = await api.gc(keep);
   * ```
   */
  const boundGc = (keep: ReadonlySet<string>): Promise<GcResult> => gc(context, keep);

  return {
    put: boundPut,
    has: boundHas,
    pathOf: boundPathOf,
    read: boundRead,
    hashOf: hashOfContent,
    gc: boundGc
  };
}
