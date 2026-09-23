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
 * and the `events()` per-consumer backpressure buffer size.
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

/** Per-item stream records delivered by events() — NEVER the plugin bus. */
export type RunEvent =
  | { type: "item:queued"; itemId: string; task: string; provider: string }
  | { type: "item:dispatching"; itemId: string }
  | { type: "item:done"; itemId: string; costUsd: number; contentHash: string }
  | { type: "item:retry"; itemId: string; errorClass: ErrorClass; attempt: number }
  | { type: "item:failed"; itemId: string; errorClass: ErrorClass }
  | { type: "item:flagged"; itemId: string }
  | { type: "overflow"; dropped: number }
  | { type: "progress"; totals: RunTotals }
  | { type: "terminal"; status: RunResultStatus; totals: RunTotals };

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

/** Live bookkeeping for the single in-process active run (M0). */
export type ActiveRun = {
  runId: string;
  signal: AbortSignal | undefined;
  subscribers: Set<EventQueue>;
  inFlight: number;
};

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

/** Runner plugin state: at most one active run per process (M0). */
export type State = { active: ActiveRun | null };

/** Public API surface of the runner plugin, exposed as `app.runner`. */
export type RunnerApi = {
  /**
   * Executes one durable run over the matched build files.
   *
   * @param options - Glob, budget cap, dry-run.
   * @param opts - Optional abort signal for a clean pause.
   * @param opts.signal - Abort signal; aborting drains to `paused`.
   * @returns The run's final result.
   */
  run(options: RunOptions, opts?: { signal?: AbortSignal }): Promise<RunResult>;
  /**
   * Continues the latest (or a given) resumable run; live provider jobs are polled, not re-submitted.
   *
   * @param opts - Optional run id and abort signal.
   * @param opts.runId - Run to resume; default the latest resumable run.
   * @param opts.signal - Abort signal; aborting drains to `paused`.
   * @returns The run's final result.
   */
  resume(opts?: { runId?: string; signal?: AbortSignal }): Promise<RunResult>;
  /**
   * The same per-item estimate the budget gate uses, grouped by task/provider. No journal writes.
   *
   * @param options - Glob options.
   * @param options.files - Glob pattern; default the buildfile default glob.
   * @returns The breakdown and total.
   */
  estimate(options: { files?: string }): Promise<EstimateResult>;
  /**
   * Read-only status snapshot of a run.
   *
   * @param runId - Run id; defaults to the active or latest resumable run.
   * @returns The status report.
   */
  status(runId?: string): RunStatusReport;
  /**
   * Per-item detail stream for the active run.
   *
   * @returns An async iterable of stream records.
   */
  events(): AsyncIterable<RunEvent>;
  /**
   * Copies a run's done artifacts to `<outDir>/<build>/<label>.<ext>`.
   *
   * @param opts - Run id (default: newest run) and output directory (default "out").
   * @param opts.runId - Run to export.
   * @param opts.outDir - Export root directory.
   * @returns The files written and the labels skipped.
   */
  export(opts?: { runId?: string; outDir?: string }): Promise<ExportResult>;
};
