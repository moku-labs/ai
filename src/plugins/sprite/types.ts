/**
 * @file sprite plugin — type definitions (re-exports the contract, plus the
 * plugin's config, public API, and domain context types).
 */
import type { PluginCtx } from "@moku-labs/core";
import type { RegistryApi, registryPlugin } from "../registry";
import type { SpriteRequest, SpriteResult } from "./contract";

export type { SpriteFile, SpriteHandler, SpriteRequest, SpriteResult } from "./contract";
export type { ProcessedSprite, SpriteProcessOptions, TrimBox } from "./process";

/**
 * sprite plugin configuration: the provider the facade uses when the caller names none.
 *
 * @example
 * ```ts
 * const app = createApp({ pluginConfigs: { sprite: { defaultProvider: "fal" } } });
 * ```
 */
export type Config = {
  /** Provider used by the facade when the caller names none. Default: "fal". */
  defaultProvider: string;
};

/**
 * Public API surface of the `sprite` plugin, exposed as `app.sprite`.
 *
 * @example
 * ```ts
 * const sprite = await app.sprite.generate({ source: file, model: "none", pixelArt: true });
 * // sprite.mimeType === "image/png"
 * ```
 */
export type SpriteApi = {
  /**
   * One-off direct cut: calls the provider's `execute` once and returns its
   * result. NOT journaled: prefer `app.runner.run()` for resumability.
   *
   * @param request - The sprite request; `source` is a resolved file.
   * @param opts - Optional provider override and abort signal.
   * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
   * @param opts.signal - Abort signal; forwarded to the provider call.
   * @returns The sprite result: a transparent RGBA PNG.
   * @throws {Error} `[ai] No sprite provider named "<name>" is registered.` when the
   * provider is unregistered or its handler is malformed.
   * @example
   * ```ts
   * // Cut an already transparent 32x32 icon with a 10x6 mark at (5,7) to its content.
   * const sprite = await app.sprite.generate({ source: iconFile, model: "none" }, { provider: "fal" });
   * // sprite.mimeType === "image/png", sprite.meta?.trimBox => { left: 5, top: 7, width: 10, height: 6 }
   * ```
   */
  generate(
    request: SpriteRequest,
    opts?: { provider?: string; signal?: AbortSignal }
  ): Promise<SpriteResult>;
  /**
   * Cost estimate without executing — calls the same handler `estimate()` the
   * runner's budget gate uses. Handlers read `model` only, because the runner
   * estimates before `source` is resolved.
   *
   * @param request - The sprite request to estimate.
   * @param opts - Optional provider override.
   * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
   * @returns The estimated cost in USD.
   * @throws {Error} The same two-line unknown-provider error as `generate`.
   * @example
   * ```ts
   * // A source that is already transparent needs no matte, so it is free.
   * app.sprite.estimate({ source: iconFile, model: "none" }); // => { usd: 0 }
   * ```
   */
  estimate(request: SpriteRequest, opts?: { provider?: string }): { usd: number };
  /**
   * Registered sprite providers, in registration order.
   *
   * @returns Registered provider names for the "sprite" task.
   * @example
   * ```ts
   * // Pick a provider for `opts.provider`: first registered is first in the list.
   * app.sprite.providers(); // => ["fal"]
   * ```
   */
  providers(): string[];
};

/** The registry's public surface — declared once in `../registry` and re-exported for this plugin's consumers. */
export type { RegistryApi } from "../registry";

/**
 * Domain context for the sprite API factory. Stateless facade over `registry`,
 * so `state` is the empty-object shape; `require` is narrowed to the registry.
 */
export type SpriteContext = PluginCtx<Config, Record<string, never>> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
};
