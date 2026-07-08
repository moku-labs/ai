/**
 * @file store core plugin — type definitions.
 */
export type Config = {
  /** Root directory of the CAS. */
  dir: string;
  /** Hash algorithm (fixed at M0). */
  algo: "sha256";
};

/**
 *
 */
export type State = {
  /** Memoized "root dir verified/created" flag. */
  rootEnsured: boolean;
};

/**
 *
 */
export type PutResult = { hash: string; path: string; existed: boolean };
/**
 *
 */
export type GcResult = { removed: number; bytesFreed: number };

/**
 *
 */
export type StoreApi = {
  put(content: Uint8Array): Promise<PutResult>;
  has(hash: string): Promise<boolean>;
  pathOf(hash: string): string;
  read(hash: string): Promise<Uint8Array>;
  hashOf(content: Uint8Array): string;
  gc(keep: ReadonlySet<string>): Promise<GcResult>;
};
