/**
 * @file codex per-call dir — creates the temp dir one image or prompt-gen
 * call runs in, under `config.workDir` or `os.tmpdir()` when it is "".
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Name prefix of every per-call temp dir. */
const CALL_DIR_PREFIX = "codex-";

/**
 * Creates the per-call temp dir under `workDirectory`, or under
 * `os.tmpdir()` when it is "". A relative root resolves against the cwd.
 *
 * @param workDirectory - `config.workDir`.
 * @returns Absolute path of the new dir.
 * @example
 * ```ts
 * await createCallDirectory(""); // => "/tmp/codex-Ab12Cd"
 * ```
 */
export async function createCallDirectory(workDirectory: string): Promise<string> {
  const root = workDirectory === "" ? tmpdir() : path.resolve(workDirectory);
  await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, CALL_DIR_PREFIX));
}
