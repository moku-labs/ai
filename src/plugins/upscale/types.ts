/**
 * @file upscale plugin — type definitions (re-exports the contract, plus the
 * plugin's config, public API, and domain context types).
 */
import type { PluginCtx } from "@moku-labs/core";
import type { RegistryApi, registryPlugin } from "../registry";
import type { UpscaleEstimateRequest, UpscaleRequest, UpscaleResult } from "./contract";

export type {
  UpscaleEstimateInput,
  UpscaleEstimateRequest,
  UpscaleFile,
  UpscaleHandler,
  UpscaleJobPoll,
  UpscaleRequest,
  UpscaleResult
} from "./contract";

/**
 * upscale plugin configuration: the default provider and the facade poll cadence.
 *
 * @example
 * ```ts
 * const config: Config = { defaultProvider: "fal", pollIntervalMs: 5000 };
 * ```
 */
export type Config = {
  /** Provider used by the facade when the caller names none. Default: "fal". */
  defaultProvider: string;
  /** Facade poll cadence for submit/poll providers, ms. Default: 5000. */
  pollIntervalMs: number;
};

/**
 * Public API surface of the `upscale` plugin, exposed as `app.upscale`.
 *
 * @example
 * ```ts
 * const request = {
 *   video: { path: "out/ep01.mp4", mimeType: "video/mp4", hash: "ab12" },
 *   model: "starlight-fast-2", factor: 1.5, seconds: 62.4
 * };
 * const up = await app.upscale.generate(request);
 * ```
 */
export type UpscaleApi = {
  /**
   * One-off direct upscale. Uses the provider's `execute` when present, otherwise
   * submits a job and polls it every `config.pollIntervalMs` until it is done or
   * failed. A failed job throws its `error` as-is; an abort rejects with the signal's
   * reason. NOT journaled: prefer `app.runner.run()` for resumability.
   *
   * @param request - The upscale request.
   * @param opts - Optional provider override and abort signal.
   * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
   * @param opts.signal - Abort signal; cancels the provider call or the poll wait.
   * @returns The upscaled video result.
   * @throws {Error} `[ai] No upscale provider named "<name>" is registered.` when the
   * provider is unregistered or its handler is malformed.
   * @example
   * ```ts
   * // Upscale a finished 62 s episode from 720p to 1080p outside the runner.
   * const up = await app.upscale.generate({
   *   video: { path: "out/ep01.mp4", mimeType: "video/mp4", hash: "ab12" },
   *   model: "starlight-fast-2", factor: 1.5, seconds: 62.4
   * });
   * // up.mimeType === "video/mp4", up.costUsd === 3.744
   * ```
   */
  generate(
    request: UpscaleRequest,
    opts?: { provider?: string; signal?: AbortSignal }
  ): Promise<UpscaleResult>;
  /**
   * Cost estimate without executing — calls the same handler `estimate()` the
   * runner's budget gate uses. `video` may still be a `$ref` / `$file` reference.
   *
   * @param request - The upscale request to estimate.
   * @param opts - Optional provider override.
   * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
   * @returns The estimated cost in USD.
   * @throws {Error} The same two-line unknown-provider error as `generate`.
   * @example
   * ```ts
   * // Check the price of a 10 s clip before adding it to a build file.
   * app.upscale.estimate({ video: { $ref: "clean" }, model: "proteus", factor: 1.5, seconds: 10 }); // => { usd: 0.2 }
   * ```
   */
  estimate(request: UpscaleEstimateRequest, opts?: { provider?: string }): { usd: number };
  /**
   * Registered upscale providers, in registration order.
   *
   * @returns Registered provider names for the "upscale" task.
   * @example
   * ```ts
   * // Pick a provider for `opts.provider`: first registered is first in the list.
   * app.upscale.providers(); // => ["fal"]
   * ```
   */
  providers(): string[];
};

/** The registry's public surface — declared once in `../registry` and re-exported for this plugin's consumers. */
export type { RegistryApi } from "../registry";

/**
 * Domain context for the upscale API factory. Stateless facade over `registry`,
 * so `state` is the empty-object shape; `require` is narrowed to the registry.
 */
export type UpscaleContext = PluginCtx<Config, Record<string, never>> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
};
