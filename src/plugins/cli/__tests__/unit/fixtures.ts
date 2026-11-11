/**
 * @file cli unit test fixtures — a capturing branded console + a fake
 * `CommandContext`/`CliContext` builder. NOT a test file itself (no
 * `.test.ts` suffix), so vitest does not collect it as a suite.
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import { createBrandConsole } from "@moku-labs/common/cli";
import { vi } from "vitest";
import type { buildfilePlugin } from "../../../buildfile";
import type { BuildfileApi, CompiledBuild } from "../../../buildfile/types";
import { composePlugin } from "../../../compose";
import type { ComposeApi, ComposeResult } from "../../../compose/types";
import type { ItemRow, JournalApi, RunSnapshot, RunTotals } from "../../../journal/types";
import { runnerPlugin } from "../../../runner";
import type {
  EstimateResult,
  ExportResult,
  RunnerApi,
  RunResult,
  RunStatusReport
} from "../../../runner/types";
import type { StoreApi } from "../../../store/types";
import type { CliContext, CommandContext, Config } from "../../types";

/** Ordered log of fake-dependency method calls, for step-ordering assertions. */
export type CallLog = string[];

/**
 * Reusable `null` sentinel for the nullable `RunRow` fields this file fakes
 * (`maxCostUsd`), mirroring runner's own `FAKE_NULL` sentinel convention.
 */
// eslint-disable-next-line unicorn/no-null -- see comment above; the single source of the null literal for this file
const FAKE_NULL = null;

/** Captures every line a `BrandConsole` writes, split by sink (stdout vs stderr). */
export type CapturingConsole = {
  ui: ReturnType<typeof createBrandConsole>;
  lines: string[];
  errorLines: string[];
};

/**
 * Builds a real `BrandConsole` (plain mode) whose sinks push into arrays
 * instead of `console.log`/`console.error`, so tests assert on rendered
 * output without hand-mocking every console method.
 *
 * @returns The console plus its captured line arrays.
 * @example
 * ```ts
 * const { ui, lines } = createCapturingConsole();
 * ui.info("hello");
 * lines; // ["› hello"]
 * ```
 */
export function createCapturingConsole(): CapturingConsole {
  const lines: string[] = [];
  const errorLines: string[] = [];
  const ui = createBrandConsole({
    write: (line: string) => lines.push(line),
    writeError: (line: string) => errorLines.push(line),
    color: false
  });
  return { ui, lines, errorLines };
}

/** The all-zero `RunTotals` fixture value. */
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

/** Per-dependency overrides accepted by {@link createFakeCommandContext}. */
export type FakeCommandContextOverrides = {
  buildfile?: Partial<BuildfileApi>;
  runner?: Partial<RunnerApi>;
  compose?: Partial<ComposeApi>;
  journal?: Partial<JournalApi>;
  log?: Partial<LogApi>;
  store?: Partial<StoreApi>;
  readIn?: CommandContext["readIn"];
  writeOut?: CommandContext["writeOut"];
  runWithAbort?: CommandContext["runWithAbort"];
};

/**
 * Builds one `ItemRow` for call tests: a done item with a content hash and a
 * cost unless the overrides say otherwise.
 *
 * @param overrides - Fields to replace on the row.
 * @returns The item row.
 * @example
 * ```ts
 * createItemRow({ status: "failed", contentHash: null });
 * ```
 */
export function createItemRow(overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    id: "item-1",
    runId: "run-1",
    planningKey: "pk-1",
    buildFile: "<inline>",
    task: "call",
    provider: "fal",
    packVersion: FAKE_NULL,
    estimatedCostUsd: 0.005,
    status: "done",
    label: "ep",
    buildName: "call",
    mimeType: "application/json",
    outputs: FAKE_NULL,
    artifactKey: "ak-1",
    contentHash: "hash-1",
    actualCostUsd: 0.005,
    attemptCount: 1,
    updatedAt: 0,
    ...overrides
  };
}

/**
 * Builds a fake `CommandContext` for command unit tests: a capturing plain
 * console, always-empty `buildfile`/`runner`/`compose` fakes, an
 * in-memory-only `journal`, and a `runWithAbort` that runs `action`
 * immediately against a fresh (never-aborted-by-default) `AbortController`.
 * Every dependency can be overridden per test.
 *
 * @param overrides - Partial overrides layered onto each fake dependency.
 * @returns A fake `CommandContext` plus its captured console output.
 * @example
 * ```ts
 * const { context, lines } = createFakeCommandContext();
 * await runValidateCommand(context, {}, []);
 * ```
 */
export function createFakeCommandContext(overrides: FakeCommandContextOverrides = {}): {
  context: CommandContext;
  lines: string[];
  errorLines: string[];
  stdout: string[];
} {
  const { ui, lines, errorLines } = createCapturingConsole();

  const buildfile: BuildfileApi = {
    compile: vi.fn(),
    loadGlob: (): Promise<CompiledBuild[]> => Promise.resolve([]),
    jsonSchema: (): Record<string, unknown> => ({ type: "object" }),
    template: (opts: { name: string }): string =>
      `# yaml-language-server: $schema=.moku/build.schema.json\n$schema: .moku/build.schema.json\nversion: 1\nname: "${opts.name}"\nitems: []\n`,
    ...overrides.buildfile
  };

  const runner: RunnerApi = {
    run: (): Promise<RunResult> =>
      Promise.resolve({ runId: "run-1", status: "done", totals: ZERO_TOTALS }),
    resume: (): Promise<RunResult> =>
      Promise.resolve({ runId: "run-1", status: "done", totals: ZERO_TOTALS }),
    estimate: (): Promise<EstimateResult> => Promise.resolve({ lines: [], totalUsd: 0 }),
    status: (runId?: string): RunStatusReport => ({
      runId: runId ?? "run-1",
      status: "active",
      totals: ZERO_TOTALS,
      updatedAt: 0
    }),

    events: async function* (): AsyncIterable<never> {},
    export: (opts?: { runId?: string; outDir?: string }): Promise<ExportResult> =>
      Promise.resolve({ runId: opts?.runId ?? "run-1", outDir: "/out", files: [], skipped: [] }),
    ...overrides.runner
  };

  const compose: ComposeApi = {
    compose: (): Promise<ComposeResult> =>
      Promise.resolve({ spec: { version: 1, name: "demo", items: [] }, text: "", costUsd: 0 }),
    ...overrides.compose
  };

  const journal: JournalApi = {
    openRun: vi.fn(),
    getRun: vi.fn(),
    latestResumableRun: vi.fn(),
    insertItems: vi.fn(),
    requeueDispatching: vi.fn(),
    gateToDispatching: vi.fn(),
    recordAttempt: vi.fn(),
    finishAttempt: vi.fn(),
    commitDone: vi.fn(),
    markFailed: vi.fn(),
    markFlagged: vi.fn(),
    setRunStatus: vi.fn(),
    totals: (): RunTotals => ZERO_TOTALS,
    listItems: (): [] => [],
    readSnapshot: (runId: string): RunSnapshot => ({
      run: {
        id: runId,
        createdAt: 0,
        status: "done",
        glob: "*",
        maxCostUsd: FAKE_NULL,
        finishedAt: 0
      },
      totals: ZERO_TOTALS,
      recentItems: []
    }),
    findDoneArtifact: vi.fn(),
    reuseDone: vi.fn(),
    setAttemptJob: vi.fn(),
    findLiveJob: vi.fn(),
    latestRun: vi.fn(),
    getItem: vi.fn(),
    isOpen: vi.fn(),
    findProviderRecord: vi.fn(),
    putProviderRecords: vi.fn(),
    deleteProviderRecord: vi.fn(),
    ...overrides.journal
  };

  const log: LogApi = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: (): [] => [],
    expect: vi.fn(),
    addSink: vi.fn(),
    reset: vi.fn(),
    clearSinks: vi.fn(),
    ...overrides.log
  };

  const store: StoreApi = {
    put: vi.fn(),
    has: vi.fn(),
    pathOf: vi.fn(),
    read: (): Promise<Uint8Array> => Promise.resolve(new Uint8Array()),
    hashOf: vi.fn(),
    gc: vi.fn(),
    ...overrides.store
  };

  const stdout: string[] = [];
  const writeOut: CommandContext["writeOut"] =
    overrides.writeOut ??
    ((text): Promise<void> => {
      stdout.push(text);
      return Promise.resolve();
    });
  const readIn: CommandContext["readIn"] =
    overrides.readIn ?? ((): Promise<string> => Promise.resolve(""));

  const runWithAbort: CommandContext["runWithAbort"] =
    overrides.runWithAbort ?? (action => action(new AbortController().signal));

  return {
    context: {
      ui,
      buildfile,
      runner,
      compose,
      journal,
      log,
      store,
      readIn,
      writeOut,
      runWithAbort
    },
    lines,
    errorLines,
    stdout
  };
}

/** Per-dependency overrides accepted by {@link createFakeCliContext}. */
export type FakeCliContextOverrides = {
  config?: Partial<Config>;
  env?: Partial<EnvApi>;
  buildfile?: Partial<BuildfileApi>;
  runner?: Partial<RunnerApi>;
  compose?: Partial<ComposeApi>;
  journal?: Partial<JournalApi>;
  store?: Partial<StoreApi>;
};

/**
 * Builds a fake `CliContext` for `api.ts`/`createCliApi` unit tests: a
 * fake `require` resolving the three declared dependencies, and a
 * permissive `env` (no `NO_COLOR`).
 *
 * @param overrides - Partial overrides layered onto each fake dependency.
 * @returns A fake `CliContext`.
 * @example
 * ```ts
 * const ctx = createFakeCliContext({ config: { plain: true } });
 * const api = createCliApi(ctx);
 * ```
 */
export function createFakeCliContext(overrides: FakeCliContextOverrides = {}): CliContext {
  const { context: commandContext } = createFakeCommandContext({
    ...(overrides.buildfile === undefined ? {} : { buildfile: overrides.buildfile }),
    ...(overrides.runner === undefined ? {} : { runner: overrides.runner }),
    ...(overrides.compose === undefined ? {} : { compose: overrides.compose }),
    ...(overrides.journal === undefined ? {} : { journal: overrides.journal }),
    ...(overrides.store === undefined ? {} : { store: overrides.store })
  });

  const env: EnvApi = {
    get: (): string | undefined => undefined,
    require: vi.fn(),
    has: (): boolean => false,
    getPublic: (): Record<string, string> => ({}),
    getPublicMap: (): ReadonlyMap<string, string> => new Map(),
    ...overrides.env
  };

  /**
   * Resolves cli's three declared dependencies to their fake APIs above —
   * the fake `ctx.require`, narrowed the same way runner/compose's own
   * fixtures narrow theirs (matched by plugin instance identity).
   *
   * @param plugin - One of cli's three declared dependency plugin instances.
   * @returns The matching fake API.
   */
  function requireImpl(plugin: typeof runnerPlugin): RunnerApi;
  function requireImpl(plugin: typeof buildfilePlugin): BuildfileApi;
  function requireImpl(plugin: typeof composePlugin): ComposeApi;
  function requireImpl(
    plugin: typeof runnerPlugin | typeof buildfilePlugin | typeof composePlugin
  ): RunnerApi | BuildfileApi | ComposeApi {
    if (plugin === runnerPlugin) return commandContext.runner;
    if (plugin === composePlugin) return commandContext.compose;
    return commandContext.buildfile;
  }

  return {
    config: { plain: false, ...overrides.config },
    state: {},
    emit: vi.fn(),
    require: requireImpl,
    journal: commandContext.journal,
    store: commandContext.store,
    log: commandContext.log,
    env
  };
}
