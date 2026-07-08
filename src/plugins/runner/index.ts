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
import { createRunnerState } from "./state";
import type { Config, RunnerEvents } from "./types";

const defaultConfig: Config = { maxAttempts: 3, retryBaseMs: 1000, eventBufferSize: 10_000 };

/**
 * runner — Complex tier plugin. Durable run orchestrator; the only event
 * declarer at M0. Depends on registry, buildfile.
 *
 * @see README.md
 */
export const runnerPlugin = createPlugin("runner", {
  depends: [registryPlugin, buildfilePlugin],
  config: defaultConfig,
  createState: createRunnerState,
  api: createRunnerApi,
  /**
   * Declares the runner's five bus events with typed payloads.
   *
   * @param register - Kernel event-registration function.
   * @returns The run:* event registrations.
   * @example
   * ```ts
   * app.on("run:done", ({ runId }) => runId);
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
  })
});
