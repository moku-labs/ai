/**
 * Complex tier — durable run pipeline: queued → gate(budget+dedup, atomic) →
 * execute → store → done. Owns all run events; per-item detail via events().
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { buildfilePlugin } from "../buildfile";
import { registryPlugin } from "../registry";
import { createRunnerApi } from "./api";
import { createRunnerState, stopActiveRuns } from "./state";
import type { Config, RunnerEvents } from "./types";

const defaultConfig: Config = {
  maxAttempts: 3,
  retryBaseMs: 1000,
  eventBufferSize: 10_000,
  pollIntervalMs: 5000,
  jobTimeoutMs: 1_800_000,
  maxActiveRuns: 1
};

/**
 * runner — Complex tier plugin. Durable run orchestrator; the only event
 * declarer at M0. Depends on registry, buildfile. `app.stop()` pauses the
 * active runs and waits for them.
 *
 * @see README.md
 */
// @no-resource-check — onStop drains the active runs before core plugins (journal) stop: regular onStop runs first (spec/03)
export const runnerPlugin = createPlugin("runner", {
  depends: [registryPlugin, buildfilePlugin],
  config: defaultConfig,
  createState: createRunnerState,
  /**
   * Declares the runner's five bus events with typed payloads.
   *
   * @param register - Kernel event-registration function.
   * @returns The run:* event registrations.
   * @example
   * ```ts
   * // Subscribe from a plugin: depends: [runnerPlugin] + a hooks map.
   * createPlugin("reporter", {
   *   depends: [runnerPlugin],
   *   hooks: () => ({ "run:done": ({ runId }) => runId })
   * });
   * ```
   */
  events: register => ({
    "run:progress": register<RunnerEvents["run:progress"]>("Coalesced run progress (≤1 per 500ms)"),
    "run:done": register<RunnerEvents["run:done"]>("Run completed"),
    "run:failed": register<RunnerEvents["run:failed"]>("Run aborted by unrecoverable error"),
    "run:budget-stop": register<RunnerEvents["run:budget-stop"]>(
      "Budget ceiling reached; run drained + stopped"
    ),
    "run:paused": register<RunnerEvents["run:paused"]>(
      "Clean pause completed (signal abort drained)"
    )
  }),
  /**
   * Wires the runner's domain context into `createRunnerApi`.
   *
   * @param ctx - Full plugin context (config, state, emit, require, core APIs).
   * @returns The runner's public API.
   * @example
   * ```ts
   * app.runner.run({ files: "voice/*.moku.yaml" });
   * ```
   */
  api: ctx => createRunnerApi(ctx),
  /**
   * Pauses every active run and waits until each one settled.
   *
   * @param ctx - Teardown context; only the runner's own state is used.
   * @param ctx.state - Runner state.
   * @returns Resolves once no run is active.
   * @example
   * ```ts
   * await app.stop(); // active runs resolve { status: "paused" } first
   * ```
   */
  onStop: ({ state }) => stopActiveRuns(state)
});
