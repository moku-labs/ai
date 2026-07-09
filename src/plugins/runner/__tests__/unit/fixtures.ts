/**
 * @file runner unit test fixtures — shared fake `RunnerContext` builder and
 * fake `ItemRow`/handler factories. NOT a test file itself (no `.test.ts`
 * suffix), so vitest does not collect it as a suite.
 */

import type { LogApi } from "@moku-labs/common";
import { vi } from "vitest";
import type { buildfilePlugin } from "../../../buildfile";
import type { BuildfileApi, CompiledBuild } from "../../../buildfile/types";
import type {
  AttemptEnd,
  AttemptStart,
  GateResult,
  ItemIntent,
  ItemRow,
  JournalApi,
  RunRow,
  RunSnapshot,
  RunTotals
} from "../../../journal/types";
import type { LimitsApi } from "../../../limits/types";
import { registryPlugin } from "../../../registry";
import type { StoreApi } from "../../../store/types";
import type { Config, ExecutableHandler, RegistryApi, RunnerContext, State } from "../../types";

/** Ordered log of fake-dependency method calls, for step-ordering assertions. */
export type CallLog = string[];

/**
 * Reusable `null` sentinel for the several nullable journal-row fields these
 * fixtures fake (`packVersion`, `artifactKey`, `maxCostUsd`, ...). Centralizes
 * the `unicorn/no-null` exception to this one line, mirroring journal's own
 * `SQL_NULL` sentinel convention.
 */
// eslint-disable-next-line unicorn/no-null -- see comment above; the single source of the null literal for this file
const FAKE_NULL = null;

/** The all-zero `RunTotals` fixture value, reused as the default fake `journal.totals()` result. */
export const ZERO_TOTALS: RunTotals = {
  total: 0,
  queued: 0,
  dispatching: 0,
  done: 0,
  failed: 0,
  flagged: 0,
  spendUsd: 0,
  estimatedRemainingUsd: 0
};

/**
 * Builds a fake `ItemRow`: a fresh `"queued"` item with sensible defaults,
 * so tests only need to override the fields they assert on.
 *
 * @param overrides - Fields to override on the default fake row.
 * @returns A fake item row.
 * @example
 * ```ts
 * const item = fakeItemRow({ task: "voiceover", provider: "elevenlabs" });
 * ```
 */
export function fakeItemRow(overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    id: "item-1",
    runId: "run-1",
    planningKey: "pk-1",
    buildFile: "build.moku.yaml",
    task: "fakeTask",
    provider: "fakeProvider",
    packVersion: FAKE_NULL,
    estimatedCostUsd: 0.1,
    status: "queued",
    artifactKey: FAKE_NULL,
    contentHash: FAKE_NULL,
    actualCostUsd: FAKE_NULL,
    attemptCount: 0,
    updatedAt: 0,
    ...overrides
  };
}

/**
 * Builds a fake `ExecutableHandler` that logs `"handler.estimate"` /
 * `"handler.execute"` to the shared call log and resolves with a fixed
 * cost, unless `execute` is overridden (e.g. to fail N times).
 *
 * @param log - Shared call-order log to append to.
 * @param options - Overrides for the fixed cost and a custom `execute`.
 * @param options.costUsd - The fixed cost `estimate`/the default `execute` report. Default 0.1.
 * @param options.execute - Custom `execute` implementation, replacing the default success path.
 * @returns A fake `ExecutableHandler`.
 * @example
 * ```ts
 * const handler = fakeHandler(log, { costUsd: 0.25 });
 * ```
 */
export function fakeHandler(
  log: CallLog,
  options: { costUsd?: number; execute?: ExecutableHandler["execute"] } = {}
): ExecutableHandler {
  const costUsd = options.costUsd ?? 0.1;
  return {
    estimate: (): { usd: number } => {
      log.push("handler.estimate");
      return { usd: costUsd };
    },
    execute:
      options.execute ??
      (async (): Promise<{ body: Uint8Array; mimeType: string; costUsd: number }> => {
        log.push("handler.execute");
        return { body: new TextEncoder().encode("artifact"), mimeType: "text/plain", costUsd };
      })
  };
}

/** Per-dependency overrides accepted by {@link createFakeRunnerContext}. */
export type FakeRunnerContextOverrides = {
  config?: Partial<Config>;
  registry?: Partial<RegistryApi>;
  buildfile?: Partial<BuildfileApi>;
  journal?: Partial<JournalApi>;
  limits?: Partial<LimitsApi>;
  store?: Partial<StoreApi>;
};

/**
 * Builds a fake `RunnerContext` for pipeline/plan unit tests: an
 * always-admits `limits`, an always-succeeds `store`, an in-memory
 * call-logging `journal`, and a `require` resolving `registryPlugin`
 * (default handler: `fakeHandler(log)`) and `buildfilePlugin` (default:
 * empty `loadGlob`). Every dependency can be overridden per test.
 *
 * @param log - Shared call-order log every fake dependency method appends to.
 * @param overrides - Partial overrides layered onto each fake dependency.
 * @returns A fake `RunnerContext`.
 * @example
 * ```ts
 * const log: CallLog = [];
 * const ctx = createFakeRunnerContext(log);
 * ```
 */
export function createFakeRunnerContext(
  log: CallLog,
  overrides: FakeRunnerContextOverrides = {}
): RunnerContext {
  const config: Config = {
    maxAttempts: 3,
    retryBaseMs: 1000,
    eventBufferSize: 10_000,
    ...overrides.config
  };
  const state: State = { active: FAKE_NULL };

  const registryApi: RegistryApi = {
    register: vi.fn(),
    resolve: (): unknown => fakeHandler(log),
    providers: (): string[] => ["fakeProvider"],
    tasks: (): string[] => ["fakeTask"],
    ...overrides.registry
  };

  const buildfileApi: BuildfileApi = {
    compile: vi.fn(),
    loadGlob: (): Promise<CompiledBuild[]> => Promise.resolve([]),
    jsonSchema: vi.fn(),
    template: vi.fn(),
    ...overrides.buildfile
  };

  /**
   * Resolves `registryPlugin`/`buildfilePlugin` to their fake APIs above —
   * the fake `ctx.require`.
   *
   * @param plugin - Either dependency plugin instance.
   * @returns The matching fake API.
   * @example
   * ```ts
   * requireImpl(registryPlugin);
   * ```
   */
  function requireImpl(plugin: typeof registryPlugin): RegistryApi;
  function requireImpl(plugin: typeof buildfilePlugin): BuildfileApi;
  function requireImpl(
    plugin: typeof registryPlugin | typeof buildfilePlugin
  ): RegistryApi | BuildfileApi {
    return plugin === registryPlugin ? registryApi : buildfileApi;
  }

  const journal: JournalApi = {
    openRun: (opts): RunRow => ({
      id: "run-1",
      createdAt: 0,
      status: "active",
      glob: opts.glob,
      maxCostUsd: opts.maxCostUsd ?? FAKE_NULL,
      finishedAt: FAKE_NULL
    }),
    getRun: (): RunRow | undefined => undefined,
    latestResumableRun: (): RunRow | undefined => undefined,
    insertItems: (_runId: string, items: ItemIntent[]): ItemRow[] =>
      items.map((item, index) => fakeItemRow({ id: `item-${index + 1}`, ...item })),
    requeueDispatching: (): number => 0,
    gateToDispatching: (itemId: string): GateResult => {
      log.push(`journal.gateToDispatching(${itemId})`);
      return { ok: true };
    },
    recordAttempt: (itemId: string, _attempt: AttemptStart): number => {
      log.push(`journal.recordAttempt(${itemId})`);
      return 1;
    },
    finishAttempt: (_attemptId: number, end: AttemptEnd): void => {
      log.push(`journal.finishAttempt(${end.outcome})`);
    },
    commitDone: (itemId: string): void => {
      log.push(`journal.commitDone(${itemId})`);
    },
    markFailed: (itemId: string, result: { terminal: boolean }): void => {
      log.push(`journal.markFailed(${itemId},${result.terminal ? "terminal" : "retry"})`);
    },
    markFlagged: (itemId: string): void => {
      log.push(`journal.markFlagged(${itemId})`);
    },
    setRunStatus: (): void => {
      log.push("journal.setRunStatus");
    },
    totals: (): RunTotals => ZERO_TOTALS,
    listItems: (): ItemRow[] => [],
    readSnapshot: (runId: string): RunSnapshot => ({
      run: {
        id: runId,
        createdAt: 0,
        status: "active",
        glob: "*",
        maxCostUsd: FAKE_NULL,
        finishedAt: FAKE_NULL
      },
      totals: ZERO_TOTALS,
      recentItems: []
    }),
    checkpoint: (): void => {
      log.push("journal.checkpoint");
    },
    ...overrides.journal
  };

  const limits: LimitsApi = {
    acquire: async (): Promise<{ release: () => void }> => {
      log.push("limits.acquire");
      return {
        release: (): void => {
          log.push("limits.release");
        }
      };
    },
    reportOutcome: (_lane: string, outcome: "ok" | "retryable-error"): void => {
      log.push(`limits.reportOutcome(${outcome})`);
    },
    laneConfig: () => ({ rpm: 60, concurrency: 4, breakerThreshold: 5, breakerCooldownMs: 30_000 }),
    snapshot: (lane: string) => ({ lane, tokens: 60, inFlight: 0, waiting: 0, breaker: "closed" }),
    lanes: (): string[] => [],
    ...overrides.limits
  };

  const store: StoreApi = {
    put: async (): Promise<{ hash: string; path: string; existed: boolean }> => {
      log.push("store.put");
      return { hash: "hash-1", path: "/fake-store/hash-1", existed: false };
    },
    has: async (): Promise<boolean> => false,
    pathOf: (): string => "/fake-store/hash-1",
    read: async (): Promise<Uint8Array> => new Uint8Array(),
    hashOf: (): string => "hash-1",
    gc: async (): Promise<{ removed: number; bytesFreed: number }> => ({
      removed: 0,
      bytesFreed: 0
    }),
    ...overrides.store
  };

  const logApi: LogApi = {
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

  return {
    config,
    state,
    emit: vi.fn(),
    require: requireImpl,
    journal,
    store,
    limits,
    log: logApi
  };
}
