/**
 * @file Shared unit-test doubles for promptGen: an in-memory registry, a
 * fake `LogApi`, a fake `LimitsApi` that records lanes, and a mock context.
 */
import type { LogApi } from "@moku-labs/common";
import { vi } from "vitest";
import type { LimitsApi } from "../../../limits/types";
import type { Config, PromptGenContext, PromptGenHandler, PromptGenRequest } from "../../types";

/**
 * In-memory registry double matching the real registry plugin's shape.
 *
 * @returns A registry with `register`/`resolve`/`providers`/`tasks`.
 */
export function createFakeRegistry() {
  const handlers = new Map<string, Map<string, unknown>>();
  return {
    register(task: string, provider: string, handler: unknown): void {
      const taskProviders = handlers.get(task) ?? new Map<string, unknown>();
      taskProviders.set(provider, handler);
      handlers.set(task, taskProviders);
    },
    resolve(task: string, provider: string): unknown {
      return handlers.get(task)?.get(provider);
    },
    providers(task: string): string[] {
      return [...(handlers.get(task)?.keys() ?? [])];
    },
    tasks(): string[] {
      return [...handlers.keys()];
    }
  };
}

/** The in-memory registry double. */
export type FakeRegistry = ReturnType<typeof createFakeRegistry>;

/**
 * Well-formed prompt-gen handler fixture: echoes the prompt back as text.
 *
 * @param name - Provider name prefixed to the echoed text.
 * @returns A handler whose `execute` answers `"<name>:<prompt>"`.
 */
export function createEchoHandler(name: string): PromptGenHandler {
  return {
    estimate: (request: PromptGenRequest) => ({ usd: request.prompt.length / 1000 }),
    execute: async (request: PromptGenRequest) => ({
      text: `${name}:${request.prompt}`,
      costUsd: request.prompt.length / 1000
    })
  };
}

/**
 * A handler whose `execute` always rejects with `error`, counting its calls.
 *
 * @param error - The value every `execute` call rejects with.
 * @returns The handler plus its `execute` mock.
 */
export function createFailingHandler(error: unknown) {
  const execute = vi.fn(async (): Promise<never> => {
    throw error;
  });
  const handler: PromptGenHandler = { estimate: () => ({ usd: 0 }), execute };
  return { handler, execute };
}

/**
 * Builds a fake `LogApi` with every method a `vi.fn()` mock.
 *
 * @returns The fake logger.
 */
export function createFakeLog() {
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
  } satisfies LogApi;
}

/** Options for {@link createFakeLimits}. */
export type FakeLimitsOptions = {
  /** Lanes whose breaker is open: `acquire` rejects at once with reason "breaker-open". */
  breakerOpen?: string[];
  /** Lanes with no free slot: `acquire` waits until its signal aborts, then rejects with the abort reason. */
  full?: string[];
};

/**
 * A fake `LimitsApi` that grants every lane at once and records which lanes
 * were acquired and released, in order.
 *
 * @param options - Lanes to reject as breaker-open or hold as full.
 * @returns The fake limits plus its `acquired`/`released` logs.
 */
export function createFakeLimits(options: FakeLimitsOptions = {}) {
  const acquired: string[] = [];
  const released: string[] = [];
  const breakerOpen = new Set(options.breakerOpen);
  const full = new Set(options.full);

  const acquire = vi.fn(
    async (lane: string, opts?: { signal?: AbortSignal }): Promise<{ release: () => void }> => {
      if (breakerOpen.has(lane)) {
        throw Object.assign(new Error(`[ai] limits: breaker open for lane "${lane}".`), {
          reason: "breaker-open"
        });
      }
      if (full.has(lane)) {
        await new Promise<never>((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(opts.signal?.reason));
        });
      }
      acquired.push(lane);
      return { release: () => released.push(lane) };
    }
  );

  const limits = {
    acquire,
    reportOutcome: vi.fn(),
    laneConfig: () => ({ rpm: 60, concurrency: 4, breakerThreshold: 5, breakerCooldownMs: 30_000 }),
    snapshot: (lane: string) => ({
      lane,
      tokens: 60,
      inFlight: 0,
      waiting: 0,
      breaker: "closed" as const
    }),
    lanes: (): string[] => []
  } satisfies LimitsApi;

  return { limits, acquired, released };
}

/** Per-dependency overrides accepted by {@link createMockCtx}. */
export type MockCtxOverrides = {
  config?: Partial<Config>;
  log?: LogApi;
  limits?: LimitsApi;
};

/**
 * Builds a mock promptGen context around a given fake registry.
 *
 * @param registry - The fake registry `require` returns.
 * @param overrides - Config fields and fake core APIs to use instead of the defaults.
 * @returns The mock context.
 */
export function createMockCtx(
  registry: FakeRegistry,
  overrides: MockCtxOverrides = {}
): PromptGenContext {
  return {
    config: { defaultProvider: "openai", fallback: [], ...overrides.config },
    state: {},
    emit: () => undefined,
    require: () => registry,
    log: overrides.log ?? createFakeLog(),
    limits: overrides.limits ?? createFakeLimits().limits
  };
}
