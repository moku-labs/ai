/**
 * @file runner plugin — type definitions (incl. RunnerEvents payload shapes).
 */

import type { LogApi } from "@moku-labs/common";
import type { PluginCtx } from "@moku-labs/core";
import type { buildfilePlugin } from "../buildfile";
import type { BuildfileApi } from "../buildfile/types";
import type { ErrorClass, ItemIntent, JournalApi, RunTotals } from "../journal/types";
import type { LimitsApi } from "../limits/types";
import type { RegistryApi, registryPlugin } from "../registry";
import type { StoreApi } from "../store/types";

/**
 * Runner plugin configuration: per-item retry ceiling, retry backoff base,
 * the `events()` per-consumer backpressure buffer size, provider-job polling,
 * and how many runs one process drives at once.
 *
 * @example
 * ```ts
 * // A studio that renders two episodes at once and polls slow video jobs every 10 s.
 * createApp({ pluginConfigs: { runner: { maxActiveRuns: 2, pollIntervalMs: 10_000 } } });
 * ```
 */
export type Config = {
  /** Default max attempts per item. */
  maxAttempts: number;
  /** Base backoff for retryable errors, ms. */
  retryBaseMs: number;
  /** events() per-consumer buffer size before overflow coalescing. */
  eventBufferSize: number;
  /** Delay between two polls of an async provider job, ms. */
  pollIntervalMs: number;
  /** An async job still pending after this long is `expired`; the next attempt polls it again before it submits. ms. */
  jobTimeoutMs: number;
  /** Cap on runs driven at once in this process; a whole number >= 1. 1 keeps the one-run-at-a-time refusal. */
  maxActiveRuns: number;
};

/** Options accepted by {@link RunnerApi.run}. */
export type RunOptions = { files?: string; maxCostUsd?: number; dryRun?: boolean };
/** Terminal (or paused) status of one `run()`/`resume()` invocation. */
export type RunResultStatus = "done" | "failed" | "paused" | "budget-stopped";
/** Settlement value returned by {@link RunnerApi.run} and {@link RunnerApi.resume}. */
export type RunResult = { runId: string; status: RunResultStatus; totals: RunTotals };

/** One task/provider line of an {@link EstimateResult} cost breakdown. */
export type EstimateLine = { task: string; provider: string; items: number; usd: number };
/** Per-task/provider cost breakdown plus its total, returned by {@link RunnerApi.estimate}. */
export type EstimateResult = { lines: EstimateLine[]; totalUsd: number };

/** Read-only status snapshot returned by {@link RunnerApi.status}. */
export type RunStatusReport = {
  runId: string;
  status: string;
  totals: RunTotals;
  updatedAt: number;
};

/** Per-item stream records delivered by events() — NEVER the plugin bus. Every record names its run. */
export type RunEvent =
  | { type: "item:queued"; runId: string; itemId: string; task: string; provider: string }
  | { type: "item:dispatching"; runId: string; itemId: string }
  | { type: "item:done"; runId: string; itemId: string; costUsd: number; contentHash: string }
  | { type: "item:retry"; runId: string; itemId: string; errorClass: ErrorClass; attempt: number }
  | { type: "item:failed"; runId: string; itemId: string; errorClass: ErrorClass }
  | { type: "item:flagged"; runId: string; itemId: string }
  | { type: "overflow"; runId: string; dropped: number }
  | { type: "progress"; runId: string; totals: RunTotals }
  | { type: "terminal"; runId: string; status: RunResultStatus; totals: RunTotals };

/** `Omit` applied to each member of a union, so the union stays discriminated. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A stream record before its run stamps `runId` on it: what the pipeline
 * reports, so per-item code never needs to know which run it serves.
 */
export type UnstampedRunEvent = DistributiveOmit<RunEvent, "runId">;

/** Bus event payloads — single source for the register<T> calls in index.ts. */
export type RunnerEvents = {
  "run:progress": {
    runId: string;
    total: number;
    done: number;
    failed: number;
    flagged: number;
    spendUsd: number;
  };
  "run:done": { runId: string; totals: RunTotals };
  "run:failed": { runId: string; error: string };
  "run:budget-stop": { runId: string; spendUsd: number; maxCostUsd: number };
  "run:paused": { runId: string; drained: number };
};

/**
 * The request payload the runner passes to a handler: the item's `input`
 * spread flat, plus `params` — exactly the task contract's request shape
 * (e.g. `VoiceoverRequest`). `$ref`/`$file` values are replaced by
 * {@link ResolvedFile}s before `execute`/`submit`; `estimate` sees them
 * unresolved. Never persisted to `ctx.journal` (redaction boundary; spec/06).
 */
export type HandlerRequest = Record<string, unknown>;

/**
 * A local file handed to a handler in place of a `$ref` (another item's
 * stored artifact) or a `$file` (a file next to the build file).
 */
export type ResolvedFile = { path: string; mimeType: string; hash: string };

/**
 * What a handler may return: the bytes under the field its task contract
 * names (`body`, `audio`, `image`, `video`) or `text`, plus cost and mime.
 * The runner normalizes it before storing.
 */
export type HandlerResult = {
  body?: Uint8Array;
  audio?: Uint8Array;
  image?: Uint8Array;
  video?: Uint8Array;
  text?: string;
  mimeType?: string;
  costUsd: number;
  meta?: Record<string, unknown>;
};

/** One poll of an async provider job. `failed` means the provider finished the job with an error. */
export type JobPoll =
  | { state: "pending" }
  | ({ state: "done" } & HandlerResult)
  | { state: "failed"; error: unknown };

/**
 * Uniform structural protocol every registered handler satisfies
 * (runtime-guarded): `estimate` plus either `execute`, or `submit` + `poll`
 * for long provider jobs. When both forms exist the runner uses
 * `submit` + `poll`, so the job id is journaled and never re-submitted.
 */
export type ExecutableHandler = {
  estimate(request: HandlerRequest): { usd: number };
  execute?(request: HandlerRequest, opts: { signal?: AbortSignal }): Promise<HandlerResult>;
  submit?(request: HandlerRequest, opts: { signal?: AbortSignal }): Promise<{ jobId: string }>;
  poll?(jobId: string, request: HandlerRequest, opts: { signal?: AbortSignal }): Promise<JobPoll>;
};

/**
 * Structural hint a provider handler may attach to a thrown error so the
 * retry taxonomy (`classifyError`/backoff in retry.ts) can classify it
 * without depending on a concrete HTTP client. All fields optional; an
 * error with none of them classifies as `"unknown"` (terminal).
 */
export type ProviderErrorHint = {
  /** HTTP status code, when the failure came from an HTTP response. */
  status?: number;
  /** Explicit classification hint that overrides status-based inference. */
  kind?: "timeout" | "network" | "content-policy";
  /** Provider-supplied Retry-After delay, ms (honored when larger than computed backoff). */
  retryAfterMs?: number;
};

/**
 * One planned build item: its durable {@link ItemIntent}, the in-memory
 * request (input/params — never journaled), and the effective per-item
 * retry ceiling resolved from the owning build file's `defaults.maxAttempts`.
 */
export type PlannedItem = {
  intent: ItemIntent;
  request: HandlerRequest;
  maxAttempts: number;
  /** `$ref` target id → that item's planning key (same run). */
  refKeys: ReadonlyMap<string, string>;
  /** `$file` path as written in the build file → the resolved local file. */
  files: ReadonlyMap<string, ResolvedFile>;
};

/** One file written by {@link RunnerApi.export}. */
export type ExportedFile = {
  label: string;
  path: string;
  bytes: number;
  costUsd: number;
  mimeType: string;
};

/** Result of {@link RunnerApi.export}: the files written and the labels skipped. */
export type ExportResult = {
  runId: string;
  outDir: string;
  files: ExportedFile[];
  skipped: string[];
};

/** The registry's public surface — declared once in `../registry` and re-exported for this plugin's consumers. */
export type { RegistryApi } from "../registry";

/**
 * `ctx.require` narrowed to the runner's two declared dependencies
 * (registry, buildfile), each resolving to its real API type. An
 * intersection of two concrete call signatures — the kernel's own generic
 * `require` satisfies both.
 */
export type RunnerRequire = ((plugin: typeof registryPlugin) => RegistryApi) &
  ((plugin: typeof buildfilePlugin) => BuildfileApi);

/**
 * Domain context type for the runner's extracted files (api.ts, pipeline.ts,
 * plan.ts). The framework's exported `PluginCtx` helper gives `config`/
 * `state`/`emit`; the runner also needs `require` (narrowed above) plus the
 * journal/store/limits/log core APIs, which `PluginCtx` intentionally omits
 * (mock with matching structural APIs per moku-testing conventions).
 */
export type RunnerContext = PluginCtx<Config, State, RunnerEvents> & {
  require: RunnerRequire;
  journal: JournalApi;
  store: StoreApi;
  limits: LimitsApi;
  log: LogApi;
};

/** A bounded per-consumer sink for {@link RunEvent} records (see stream.ts). */
export type EventQueue = { push(event: RunEvent): void; close(): void };

/** One `events()` consumer: its queue, and the run it follows (`undefined` = every run). */
export type Subscriber = { queue: EventQueue; runId: string | undefined };

/** Live bookkeeping for one run this process drives now. */
export type ActiveRun = {
  runId: string;
  signal: AbortSignal | undefined;
  /** Items admitted but not yet settled. */
  inFlight: number;
  /** Aborted by `app.stop()`: the run drains to `paused`, like a caller abort. */
  stop: AbortController;
  /** Resolves once the run left `state.active` and its streams closed. */
  settled: Promise<void>;
  /** Resolves `settled`. */
  settle: () => void;
};

/**
 * How the item holding an artifact claim ended, copied by the items waiting
 * on it: `done` (reuse its artifact), `flagged` / `failed` (record the same
 * verdict, no submit), or `open` (it stopped without a final provider
 * verdict: a drain, a budget stop, a refused lane, or retryable attempts
 * exhausted; its job, if any, stays adoptable).
 */
export type ClaimVerdict =
  | { kind: "done" }
  | { kind: "flagged" }
  | { kind: "failed"; errorClass: ErrorClass }
  | { kind: "open" };

/** The one item allowed to reach the provider for an artifact key right now. */
export type Claim = { itemId: string; settled: Promise<ClaimVerdict> };

/**
 * Coordinates a clean drain: a merged abort signal (external `opts.signal`
 * OR an internal budget-stop trigger) plus a `budgetStopped` flag the
 * caller reads to pick the run's final status.
 */
export type DrainController = {
  readonly signal: AbortSignal;
  readonly budgetStopped: boolean;
  triggerBudgetStop(): void;
};

/**
 * Runner plugin state: the runs this process drives now (keyed by runId, in
 * start order, at most `maxActiveRuns`), the `events()` consumers, and the
 * artifact claims that keep one provider call per artifact key across runs.
 */
export type State = {
  active: Map<string, ActiveRun>;
  subscribers: Set<Subscriber>;
  claims: Map<string, Claim>;
};

/** Public API surface of the runner plugin, exposed as `app.runner`. */
export type RunnerApi = {
  /**
   * Executes one durable run over the matched build files. Several runs may
   * run at once, up to `maxActiveRuns`; each keeps its own budget, totals,
   * signal and status, and they share lanes and artifacts.
   *
   * @param options - Glob, budget cap, dry-run.
   * @param opts - Optional abort signal and start callback.
   * @param opts.signal - Abort signal; aborting drains to `paused`.
   * @param opts.onStart - Called once, synchronously, with the new runId, before any item record.
   * @returns The run's final result.
   * @throws {Error} When `maxActiveRuns` is invalid or already reached.
   * @example
   * ```ts
   * // Episode 2 starts while episode 1 renders (maxActiveRuns: 2); its runId is known at once.
   * const ep2 = app.runner.run({ files: "ep02/*.moku.yaml", maxCostUsd: 20 }, { onStart: runId => watch(runId) });
   * await ep2; // { runId: "7f3c…", status: "done", totals: { total: 14, done: 14, … } }
   * ```
   */
  run(
    options: RunOptions,
    opts?: { signal?: AbortSignal; onStart?: (runId: string) => void }
  ): Promise<RunResult>;
  /**
   * Continues the latest (or a given) resumable run; live provider jobs are
   * polled, not re-submitted. Works while other runs are active; the default
   * target skips the runs this process drives now.
   *
   * @param opts - Optional run id, abort signal and start callback.
   * @param opts.runId - Run to resume; default the newest resumable run that is not active here.
   * @param opts.signal - Abort signal; aborting drains to `paused`.
   * @param opts.onStart - Called once, synchronously, with the runId, before any item record.
   * @returns The run's final result.
   * @throws {Error} When `maxActiveRuns` is reached, the run is already active here, or no run can be resumed.
   * @example
   * ```ts
   * // Yesterday's paused episode continues while today's run keeps going.
   * const result = await app.runner.resume();
   * result.status; // "done": its done items were not billed again
   * ```
   */
  resume(opts?: {
    runId?: string;
    signal?: AbortSignal;
    onStart?: (runId: string) => void;
  }): Promise<RunResult>;
  /**
   * The same per-item estimate the budget gate uses, grouped by task/provider. No journal writes.
   *
   * @param options - Glob options.
   * @param options.files - Glob pattern; default the buildfile default glob.
   * @returns The breakdown and total.
   * @example
   * ```ts
   * // Price the voice lines before paying for them.
   * const { lines, totalUsd } = await app.runner.estimate({ files: "voice/*.moku.yaml" });
   * // lines: [{ task: "voiceover", provider: "elevenlabs", items: 12, usd: 1.8 }], totalUsd: 1.8
   * ```
   */
  estimate(options: { files?: string }): Promise<EstimateResult>;
  /**
   * Read-only status snapshot of a run.
   *
   * @param runId - Run id; defaults to the newest active run, else the latest resumable run.
   * @returns The status report.
   * @throws {Error} When no run id is given and none can be inferred.
   * @example
   * ```ts
   * // A dashboard polls the newest run this process drives.
   * const { runId, status, totals } = app.runner.status();
   * // status: "active", totals.done: 9 of totals.total: 14
   * ```
   */
  status(runId?: string): RunStatusReport;
  /**
   * Per-item detail stream. With a `runId`: that run's records, closed after
   * its `terminal` record; an already-closed empty stream when that run is not
   * active. Without: the records of every run active now or started later,
   * closed once no run is active. Every record carries its `runId`.
   *
   * @param opts - Optional run to follow.
   * @param opts.runId - Follow only this run.
   * @returns An async iterable of stream records.
   * @example
   * ```ts
   * // Follow one run from its first record: open its stream inside onStart.
   * const follow = async (runId: string) => { for await (const event of app.runner.events({ runId })) render(event); };
   * await app.runner.run({ files: "ep01/*.moku.yaml" }, { onStart: runId => void follow(runId) });
   * ```
   */
  events(opts?: { runId?: string }): AsyncIterable<RunEvent>;
  /**
   * Copies a run's done artifacts to `<outDir>/<build>/<label>.<ext>`.
   *
   * @param opts - Run id (default: newest run) and output directory (default "out").
   * @param opts.runId - Run to export.
   * @param opts.outDir - Export root directory.
   * @returns The files written and the labels skipped.
   * @example
   * ```ts
   * // Hand the newest run's clips to the editor.
   * const { files, skipped } = await app.runner.export({ outDir: "out" });
   * // files[0]: { label: "e01.s01.h3", path: "/repo/out/ep01/e01.s01.h3.mp4", bytes: 4_812_331, costUsd: 0.3, mimeType: "video/mp4" }
   * ```
   */
  export(opts?: { runId?: string; outDir?: string }): Promise<ExportResult>;
};
