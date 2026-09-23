/**
 * @file video plugin — type definitions (re-exports the contract, plus the
 * plugin's config, public API, and domain context types).
 */
import type { PluginCtx } from "@moku-labs/core";
import type { RegistryApi, registryPlugin } from "../registry";
import type { VideoRequest, VideoResult } from "./contract";

export type {
  VideoFile,
  VideoHandler,
  VideoJobPoll,
  VideoRequest,
  VideoResult
} from "./contract";

/**
 * video plugin configuration: the provider used when a request doesn't name
 * one, and the poll cadence of the facade's in-memory submit/poll loop.
 *
 * @example
 * ```ts
 * const config: Config = { defaultProvider: "fal", pollIntervalMs: 5000 };
 * ```
 */
export type Config = {
  /** Provider used by the facade when the caller names none. Default: "fal". */
  defaultProvider: string;
  /** Facade poll cadence, ms. Default: 5000. */
  pollIntervalMs: number;
};

/**
 * Public API surface of the `video` plugin, exposed as `app.video`. A typed,
 * one-off facade over the registry's opaque handler transport for the
 * "video" task.
 *
 * @example
 * ```ts
 * const clip = await app.video.generate({ model: "minimax-h3", prompt: "slow push-in" });
 * ```
 */
export type VideoApi = {
  /**
   * One-off direct generation. Uses the provider's `execute` when present,
   * otherwise submits a job and polls it every `config.pollIntervalMs`
   * until it is done or failed. NOT journaled: prefer `app.runner.run()`
   * for anything that needs resumability or durable cost tracking.
   *
   * @param request - The video request.
   * @param opts - Optional provider override and abort signal.
   * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
   * @param opts.signal - Abort signal; cancels the provider call or the poll wait.
   * @returns The generated video result.
   * @example
   * ```ts
   * await app.video.generate({ model: "minimax-h3", prompt: "push-in" }, { provider: "fal" });
   * ```
   */
  generate(
    request: VideoRequest,
    opts?: { provider?: string; signal?: AbortSignal }
  ): Promise<VideoResult>;
  /**
   * Cost estimate without executing — calls the same handler `estimate()`
   * the runner's budget gate uses.
   *
   * @param request - The video request to estimate.
   * @param opts - Optional provider override.
   * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
   * @returns The estimated cost in USD.
   * @example
   * ```ts
   * app.video.estimate({ model: "minimax-h3", prompt: "push-in", seconds: 5 }); // => { usd: 0.25 }
   * ```
   */
  estimate(request: VideoRequest, opts?: { provider?: string }): { usd: number };
  /**
   * Registered video providers, in registration order.
   *
   * @returns Registered provider names for the "video" task.
   * @example
   * ```ts
   * app.video.providers(); // => ["fal"]
   * ```
   */
  providers(): string[];
};

/** The registry's public surface — declared once in `../registry` and re-exported for this plugin's consumers. */
export type { RegistryApi } from "../registry";

/**
 * Domain context for the video API factory. `video` is a stateless facade
 * over `registry` (no `createState`), so `state` is the empty-object shape;
 * `require` is narrowed to the one dependency this plugin calls.
 *
 * @example
 * ```ts
 * export const createVideoApi = (ctx: VideoContext): VideoApi => ({ ... });
 * ```
 */
export type VideoContext = PluginCtx<Config, Record<string, never>> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
};
