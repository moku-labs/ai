/**
 * @file codex unit test fixtures — fake `CodexContext` builder, fake
 * `registry`/`env`/`log`, and a fake `codex` executable writer. NOT a test
 * file itself (no `.test.ts` suffix), so vitest does not collect it.
 */
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EnvApi, LogApi } from "@moku-labs/common";
import { vi } from "vitest";
import type { CodexContext, Config, RegistryApi, State } from "../../types";

/** Default config fixture, matching `codexPlugin`'s own defaults. */
const DEFAULT_CONFIG: Config = {
  bin: "codex",
  model: "gpt-6-astra",
  reasoningEffort: "low",
  timeoutMs: 600_000,
  workDir: ".moku/tmp",
  priceOverrides: {}
};

/**
 * Builds an in-memory fake mirroring registry's real register/resolve behavior.
 *
 * @returns A fake `RegistryApi`.
 * @example
 * ```ts
 * const registry = createFakeRegistry();
 * ```
 */
export function createFakeRegistry(): RegistryApi {
  const handlers = new Map<string, Map<string, unknown>>();
  return {
    register(task, provider, handler) {
      const taskProviders = handlers.get(task) ?? new Map<string, unknown>();
      taskProviders.set(provider, handler);
      handlers.set(task, taskProviders);
    },
    resolve(task, provider) {
      return handlers.get(task)?.get(provider);
    },
    providers(task) {
      return [...(handlers.get(task)?.keys() ?? [])];
    },
    tasks() {
      return [...handlers.keys()];
    }
  };
}

/**
 * Builds a fake `EnvApi` backed by a plain record of resolved variables.
 *
 * @param values - The resolved variables this fake exposes.
 * @returns A fake `EnvApi`.
 * @example
 * ```ts
 * const env = createFakeEnv({ PATH: "/usr/bin" });
 * ```
 */
export function createFakeEnv(values: Record<string, string> = {}): EnvApi {
  return {
    get: key => values[key],
    require: key => {
      const value = values[key];
      if (value === undefined) {
        throw new Error(`[ai] ${key} is not set.\n  Export it or provide a default.`);
      }
      return value;
    },
    has: key => key in values,
    getPublic: () => ({ ...values }),
    getPublicMap: () => new Map(Object.entries(values))
  };
}

/**
 * Builds a fake `LogApi` with every method a `vi.fn()` mock.
 *
 * @returns A fake `LogApi`.
 * @example
 * ```ts
 * const log = createFakeLog();
 * ```
 */
export function createFakeLog(): LogApi {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: () => [],
    expect: vi.fn(),
    addSink: vi.fn(),
    reset: vi.fn(),
    clearSinks: vi.fn()
  };
}

/** Per-dependency overrides accepted by {@link createTestCtx}. */
export type TestCtxOverrides = {
  config?: Partial<Config>;
  state?: Partial<State>;
  registry?: RegistryApi;
  env?: EnvApi;
  log?: LogApi;
};

/**
 * Builds a fake `CodexContext`: default config, an uncomputed price table,
 * a no-op `emit`, and fake `registry`/`env`/`log` dependencies.
 *
 * @param overrides - Per-dependency overrides.
 * @returns A fake `CodexContext`.
 * @example
 * ```ts
 * const ctx = createTestCtx({ config: { bin: "/tmp/fake-codex" } });
 * ```
 */
export function createTestCtx(overrides: TestCtxOverrides = {}): CodexContext {
  const config: Config = { ...DEFAULT_CONFIG, ...overrides.config };
  // eslint-disable-next-line unicorn/no-null -- State.prices is `X | null`; mirrors createCodexState's sentinel
  const state: State = { prices: null, ...overrides.state };
  const registry = overrides.registry ?? createFakeRegistry();
  const env = overrides.env ?? createFakeEnv();
  const log = overrides.log ?? createFakeLog();
  return { config, state, emit: () => undefined, require: () => registry, env, log };
}

/** Shell snippet writing a tiny PNG signature to `$dir/output.png`. */
export const WRITE_OUTPUT_PNG = String.raw`printf '\211PNG\r\n\032\n' > "$dir/output.png"`;

/**
 * Writes an executable fake `codex` shell script into `root`. The script
 * header resolves `-C <dir>` into `$dir`, records its argv (one per line)
 * to `<root>/args.txt`, its cwd to `<root>/cwd.txt`, and the `$dir`
 * listing to `<root>/ls.txt`; then runs `body`.
 *
 * @param root - Test-owned temp directory (outlives the handler's own temp dir).
 * @param body - Shell commands to run after the header.
 * @returns Absolute path of the fake executable.
 * @example
 * ```ts
 * const bin = writeFakeCodex(root, WRITE_OUTPUT_PNG);
 * ```
 */
export function writeFakeCodex(root: string, body: string): string {
  const bin = path.join(root, "fake-codex");
  const script = [
    "#!/bin/sh",
    'dir=""',
    'prev=""',
    'for arg in "$@"; do',
    '  if [ "$prev" = "-C" ]; then dir="$arg"; fi',
    '  prev="$arg"',
    "done",
    String.raw`printf '%s\n' "$@" > "${root}/args.txt"`,
    `pwd > "${root}/cwd.txt"`,
    `ls "$dir" > "${root}/ls.txt"`,
    body,
    ""
  ].join("\n");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return bin;
}
