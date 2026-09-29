/**
 * @file claude unit test fixtures — fake `ClaudeContext` builder, fake
 * `registry`/`env`/`log`, captured CLI output samples, and a fake `claude`
 * executable writer. NOT a test file itself (no `.test.ts` suffix).
 */
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EnvApi, LogApi } from "@moku-labs/common";
import { vi } from "vitest";
import type { ClaudeContext, Config, RegistryApi } from "../../types";

/** Default config fixture, matching `claudePlugin`'s own defaults. */
const DEFAULT_CONFIG: Config = {
  bin: "claude",
  textModel: "",
  modelMap: {},
  timeoutMs: 600_000,
  workDir: ""
};

/**
 * Captured 2026-09-29 (Claude Code 2.1.280): a successful `claude -p` call,
 * exit 0. The elided `modelUsage`/`usage` bodies are filled with small counts.
 */
export const SUCCESS_STDOUT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ok",
  total_cost_usd: 0.114_22,
  modelUsage: {
    "claude-haiku-4-5-20251001": { inputTokens: 12, outputTokens: 3, costUSD: 0.114_22 }
  },
  usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 0 }
});

/** Captured 2026-09-29: not logged in. Exits 1 with valid JSON on stdout. */
export const NOT_LOGGED_IN_STDOUT = JSON.stringify({
  is_error: true,
  subtype: "success",
  // eslint-disable-next-line unicorn/no-null -- verbatim captured CLI output
  api_error_status: null,
  terminal_reason: "api_error",
  result: "Not logged in · Please run /login"
});

/**
 * A synthetic `claude -p` JSON result.
 *
 * @param fields - Fields merged over a successful result.
 * @returns The JSON text.
 */
export function claudeJson(fields: Record<string, unknown>): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...fields
  });
}

/**
 * Shell snippet printing `text` to stdout verbatim.
 *
 * @param text - Text to print (JSON sample).
 * @returns The shell snippet.
 */
export function printStdout(text: string): string {
  return `cat <<'MOKU_EOF'\n${text}\nMOKU_EOF`;
}

/**
 * Builds an in-memory fake mirroring registry's real register/resolve behavior.
 *
 * @returns A fake `RegistryApi`.
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
  registry?: RegistryApi;
  env?: EnvApi;
  log?: LogApi;
};

/**
 * Builds a fake `ClaudeContext`: default config, no state, a no-op `emit`,
 * and fake `registry`/`env`/`log` dependencies.
 *
 * @param overrides - Per-dependency overrides.
 * @returns A fake `ClaudeContext`.
 */
export function createTestCtx(overrides: TestCtxOverrides = {}): ClaudeContext {
  const config: Config = { ...DEFAULT_CONFIG, ...overrides.config };
  const registry = overrides.registry ?? createFakeRegistry();
  const env = overrides.env ?? createFakeEnv();
  const log = overrides.log ?? createFakeLog();
  return { config, state: {}, emit: () => undefined, require: () => registry, env, log };
}

/**
 * Writes an executable fake `claude` shell script into `root`. The script
 * header records its argv (one per line) to `<root>/args.txt`, its cwd to
 * `<root>/cwd.txt`, the cwd listing to `<root>/ls.txt`, and its stdin to
 * `<root>/stdin.txt`; then runs `body`.
 *
 * @param root - Test-owned temp directory (outlives the handler's own temp dir).
 * @param body - Shell commands to run after the header.
 * @returns Absolute path of the fake executable.
 */
export function writeFakeClaude(root: string, body: string): string {
  const bin = path.join(root, "fake-claude");
  const script = [
    "#!/bin/sh",
    String.raw`printf '%s\n' "$@" > "${root}/args.txt"`,
    `pwd > "${root}/cwd.txt"`,
    `ls > "${root}/ls.txt"`,
    `cat > "${root}/stdin.txt"`,
    body,
    ""
  ].join("\n");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return bin;
}
