/**
 * @file sfx plugin — type definitions (re-exports the contract, plus the
 * plugin's config, public API, and domain context types).
 */
import type { PluginCtx } from "@moku-labs/core";
import type { RegistryApi, registryPlugin } from "../registry";
import type { SfxRequest, SfxResult } from "./contract";

export type { SfxHandler, SfxRequest, SfxResult } from "./contract";

/**
 * sfx plugin configuration: the provider the facade uses by default.
 *
 * @example
 * ```ts
 * const config: Config = { defaultProvider: "elevenlabs" };
 * ```
 */
export type Config = {
  /** Provider used by the facade when the caller names none. Default: "elevenlabs". */
  defaultProvider: string;
};

/**
 * Public API surface of the `sfx` plugin, exposed as `app.sfx`.
 *
 * @example
 * ```ts
 * const hit = await app.sfx.generate({ prompt: "sword hit, metallic", model: "eleven_text_to_sound_v2", durationMs: 800 });
 * ```
 */
export type SfxApi = {
  /**
   * One-off direct generation: resolves the provider's handler and calls its
   * `execute` once. NOT journaled: prefer `app.runner.run()` for resumability.
   *
   * @param request - The sfx request.
   * @param opts - Optional provider override and abort signal.
   * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
   * @param opts.signal - Abort signal; passed to the provider's `execute`.
   * @returns The generated sound effect, always `audio/mpeg`.
   * @throws {Error} `[ai] No sfx provider named "<name>" is registered.` when the
   * provider is unregistered or its handler is malformed.
   * @example
   * ```ts
   * // Make a sword-hit sound for a prototype, outside the runner.
   * const hit = await app.sfx.generate({
   *   prompt: "sword hit, metallic", model: "eleven_text_to_sound_v2", durationMs: 800
   * });
   * // hit.mimeType === "audio/mpeg"
   * await Bun.write("sword-hit.mp3", hit.audio);
   * ```
   */
  generate(
    request: SfxRequest,
    opts?: { provider?: string; signal?: AbortSignal }
  ): Promise<SfxResult>;
  /**
   * Cost estimate without executing — calls the same handler `estimate()` the
   * runner's budget gate uses.
   *
   * @param request - The sfx request to estimate.
   * @param opts - Optional provider override.
   * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
   * @returns The estimated cost in USD.
   * @throws {Error} The same two-line unknown-provider error as `generate`.
   * @example
   * ```ts
   * // Compare the fal fallback's price before adding a build item with `provider: fal`.
   * const { usd } = app.sfx.estimate(
   *   { prompt: "coin pickup", model: "elevenlabs-sfx-v2", durationMs: 2000 },
   *   { provider: "fal" }
   * );
   * ```
   */
  estimate(request: SfxRequest, opts?: { provider?: string }): { usd: number };
  /**
   * Registered sfx providers, in registration order.
   *
   * @returns Registered provider names for the "sfx" task.
   * @example
   * ```ts
   * // Pick a provider for `opts.provider`: first registered is first in the list.
   * app.sfx.providers(); // => ["elevenlabs", "fal"]
   * ```
   */
  providers(): string[];
};

/** The registry's public surface — declared once in `../registry` and re-exported for this plugin's consumers. */
export type { RegistryApi } from "../registry";

/**
 * Domain context for the sfx API factory. Stateless facade over `registry`,
 * so `state` is the empty-object shape; `require` is narrowed to the registry.
 */
export type SfxContext = PluginCtx<Config, Record<string, never>> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
};
