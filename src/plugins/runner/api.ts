/**
 * @file runner plugin — API factory skeleton.
 */
import type { RunnerApi } from "./types";

/**
 * Creates the runner API surface (run/resume/estimate/status/events).
 *
 * @param _ctx - Plugin context (unused in skeleton).
 * @example
 * ```ts
 * const api = createRunnerApi(ctx);
 * ```
 */
export function createRunnerApi(_ctx: unknown): RunnerApi {
  throw new Error("not implemented");
}
