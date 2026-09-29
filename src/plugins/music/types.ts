/**
 * @file music plugin — type definitions (re-exports the contract, plus the
 * plugin's config, public API, and domain context types).
 */
import type { PluginCtx } from "@moku-labs/core";
import type { RegistryApi, registryPlugin } from "../registry";
import type { MusicRequest, MusicResult } from "./contract";

export type {
  MusicChunk,
  MusicHandler,
  MusicJobPoll,
  MusicRequest,
  MusicResult
} from "./contract";

/**
 * music plugin configuration: the default provider and the facade poll cadence.
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
 * Public API surface of the `music` plugin, exposed as `app.music`.
 *
 * @example
 * ```ts
 * const request = { prompt: "tense synth", model: "stable-audio-2.5", lengthMs: 30_000 };
 * const track = await app.music.generate(request);
 * ```
 */
export type MusicApi = {
  /**
   * One-off direct generation. Uses the provider's `execute` when present, otherwise
   * submits a job and polls it every `config.pollIntervalMs` until it is done or
   * failed. A failed job throws its `error` as-is; an abort rejects with the signal's
   * reason. NOT journaled: prefer `app.runner.run()` for resumability.
   *
   * @param request - The music request.
   * @param opts - Optional provider override and abort signal.
   * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
   * @param opts.signal - Abort signal; cancels the provider call or the poll wait.
   * @returns The generated music result.
   * @throws {Error} `[ai] No music provider named "<name>" is registered.` when the
   * provider is unregistered or its handler is malformed.
   * @example
   * ```ts
   * // Score a 60 s teaser outside the runner.
   * const track = await app.music.generate({
   *   prompt: "tense synth pulse", model: "elevenlabs-music-v2.5", lengthMs: 60_000
   * });
   * // track.mimeType === "audio/mpeg", track.costUsd === 0.8
   * ```
   */
  generate(
    request: MusicRequest,
    opts?: { provider?: string; signal?: AbortSignal }
  ): Promise<MusicResult>;
  /**
   * Cost estimate without executing — calls the same handler `estimate()` the
   * runner's budget gate uses.
   *
   * @param request - The music request to estimate.
   * @param opts - Optional provider override.
   * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
   * @returns The estimated cost in USD.
   * @throws {Error} The same two-line unknown-provider error as `generate`.
   * @example
   * ```ts
   * // Check the price of a 30 s cue before adding it to a build file.
   * app.music.estimate({ prompt: "x", model: "stable-audio-2.5", lengthMs: 30_000 }); // => { usd: 0.2 }
   * ```
   */
  estimate(request: MusicRequest, opts?: { provider?: string }): { usd: number };
  /**
   * Registered music providers, in registration order.
   *
   * @returns Registered provider names for the "music" task.
   * @example
   * ```ts
   * // Pick a provider for `opts.provider`: first registered is first in the list.
   * app.music.providers(); // => ["fal"]
   * ```
   */
  providers(): string[];
};

/** The registry's public surface — declared once in `../registry` and re-exported for this plugin's consumers. */
export type { RegistryApi } from "../registry";

/**
 * Domain context for the music API factory. Stateless facade over `registry`,
 * so `state` is the empty-object shape; `require` is narrowed to the registry.
 */
export type MusicContext = PluginCtx<Config, Record<string, never>> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
};
