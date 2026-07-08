/**
 * @file runner plugin — type definitions (incl. RunnerEvents payload shapes).
 */
import type { ErrorClass, RunTotals } from "../journal/types";

/**
 *
 */
export type Config = {
  /** Default max attempts per item. */
  maxAttempts: number;
  /** Base backoff for retryable errors, ms. */
  retryBaseMs: number;
  /** events() per-consumer buffer size before overflow coalescing. */
  eventBufferSize: number;
};

/**
 *
 */
export type RunOptions = { files?: string; maxCostUsd?: number; dryRun?: boolean };
/**
 *
 */
export type RunResultStatus = "done" | "failed" | "paused" | "budget-stopped";
/**
 *
 */
export type RunResult = { runId: string; status: RunResultStatus; totals: RunTotals };

/**
 *
 */
export type EstimateLine = { task: string; provider: string; items: number; usd: number };
/**
 *
 */
export type EstimateResult = { lines: EstimateLine[]; totalUsd: number };

/**
 *
 */
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

/** Uniform structural protocol every registered handler satisfies (runtime-guarded). */
export type ExecutableHandler = {
  estimate(request: unknown): { usd: number };
  execute(
    request: unknown,
    opts: { signal?: AbortSignal }
  ): Promise<{ body: Uint8Array; mimeType: string; costUsd: number }>;
};

/**
 *
 */
export type EventQueue = { push(event: RunEvent): void; close(): void };

/**
 *
 */
export type ActiveRun = {
  runId: string;
  signal: AbortSignal | undefined;
  subscribers: Set<EventQueue>;
  inFlight: number;
};

/**
 *
 */
export type State = { active: ActiveRun | null };

/**
 *
 */
export type RunnerApi = {
  run(options: RunOptions, opts?: { signal?: AbortSignal }): Promise<RunResult>;
  resume(opts?: { runId?: string; signal?: AbortSignal }): Promise<RunResult>;
  estimate(options: { files?: string }): Promise<EstimateResult>;
  status(runId?: string): RunStatusReport;
  events(): AsyncIterable<RunEvent>;
};
