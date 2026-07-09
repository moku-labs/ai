/**
 * @file elevenlabs unit test fixtures — shared fake `ElevenlabsContext`
 * builder plus fake `registry`/`env`/`log`. NOT a test file itself (no
 * `.test.ts` suffix), so vitest does not collect it as a suite.
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import { vi } from "vitest";
import type { Config, ElevenlabsContext, RegistryApi, State } from "../../types";

/** Default config fixture, matching `elevenlabsPlugin`'s own defaults. */
const DEFAULT_CONFIG: Config = {
  apiKeyEnv: "ELEVENLABS_API_KEY",
  baseUrl: "https://api.elevenlabs.io",
  defaultModel: "eleven_multilingual_v2",
  timeoutMs: 60_000,
  priceOverrides: {}
};

/**
 * Builds an in-memory fake mirroring registry's real
 * register/resolve/providers/tasks behavior.
 *
 * @returns A fake `RegistryApi`.
 * @example
 * ```ts
 * const registry = createFakeRegistry();
 * registry.register("voiceover", "elevenlabs", handler);
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
 * Builds an in-memory fake `EnvApi` backed by a plain record of resolved
 * variables — mirrors the real env plugin's `get`/`require`/`has` contract.
 *
 * @param values - The resolved variables this fake exposes.
 * @returns A fake `EnvApi`.
 * @example
 * ```ts
 * const env = createFakeEnv({ ELEVENLABS_API_KEY: "test-key" });
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
 * Builds a fake `LogApi` with every method a `vi.fn()` mock, for
 * call-shape assertions (`ctx.log.warn`/`ctx.log.info` argument checks).
 *
 * @returns A fake `LogApi`.
 * @example
 * ```ts
 * const log = createFakeLog();
 * expect(log.warn).toHaveBeenCalledWith("elevenlabs:voiceover:failed", { errorType: "terminal", status: 400 });
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
 * Builds a fake `ElevenlabsContext` for unit tests: default config, an
 * uncomputed price table, a typed no-op `emit` (elevenlabs declares no
 * events), and fake `registry`/`env`/`log` dependencies — every field
 * overridable per test.
 *
 * @param overrides - Per-dependency overrides.
 * @returns A fake `ElevenlabsContext`.
 * @example
 * ```ts
 * const ctx = createTestCtx({ env: createFakeEnv({ ELEVENLABS_API_KEY: "key" }) });
 * ```
 */
export function createTestCtx(overrides: TestCtxOverrides = {}): ElevenlabsContext {
  const config: Config = { ...DEFAULT_CONFIG, ...overrides.config };
  // eslint-disable-next-line unicorn/no-null -- State.prices is `X | null`; mirrors createElevenlabsState's sentinel
  const state: State = { prices: null, ...overrides.state };
  const registry = overrides.registry ?? createFakeRegistry();
  const env = overrides.env ?? createFakeEnv();
  const log = overrides.log ?? createFakeLog();
  return { config, state, emit: () => undefined, require: () => registry, env, log };
}
