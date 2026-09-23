/**
 * @file image plugin — type definitions (re-exports the contract, plus the
 * plugin's config, public API, and domain context types).
 */
import type { PluginCtx } from "@moku-labs/core";
import type { RegistryApi, registryPlugin } from "../registry";
import type { ImageRequest, ImageResult } from "./contract";

export type { ImageFile, ImageHandler, ImageRequest, ImageResult } from "./contract";

/**
 * image plugin configuration: the provider used when a request doesn't name one.
 *
 * @example
 * ```ts
 * const config: Config = { defaultProvider: "codex" };
 * ```
 */
export type Config = {
  /** Provider used by the facade when the caller names none. Default: "codex". */
  defaultProvider: string;
};

/**
 * Public API surface of the `image` plugin, exposed as `app.image`. A typed,
 * one-off facade over the registry's opaque handler transport for the
 * "image" task: providers register their `ImageHandler` under this task
 * name, and this API resolves, audits, and dispatches to them.
 *
 * @example
 * ```ts
 * const { image, costUsd } = await app.image.generate({ prompt: "a patisserie at night" });
 * ```
 */
export type ImageApi = {
  /**
   * One-off direct generation — resolves the named (or default) provider,
   * performs the one audited cast from the registry's opaque handler, and
   * executes it. NOT journaled: prefer `app.runner.run()` for anything that
   * needs resumability or durable cost tracking.
   *
   * @param request - The image request (prompt plus optional hints).
   * @param opts - Optional provider override and abort signal.
   * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
   * @param opts.signal - Optional abort signal to cancel the request.
   * @returns The generated image result.
   * @example
   * ```ts
   * await app.image.generate({ prompt: "a cat", aspect: "1:1" }, { provider: "fal" });
   * ```
   */
  generate(
    request: ImageRequest,
    opts?: { provider?: string; signal?: AbortSignal }
  ): Promise<ImageResult>;
  /**
   * Cost of one request on a provider — calls the same handler `estimate()`
   * the runner's budget gate uses, so the two never disagree.
   *
   * @param request - The image request to estimate.
   * @param opts - Optional provider override.
   * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
   * @returns The estimated cost in USD.
   * @example
   * ```ts
   * app.image.estimate({ prompt: "a cat" }); // => { usd: 0.04 }
   * ```
   */
  estimate(request: ImageRequest, opts?: { provider?: string }): { usd: number };
  /**
   * Registered image providers, in registration order (first = task default).
   *
   * @returns Registered provider names for the "image" task.
   * @example
   * ```ts
   * app.image.providers(); // => ["codex", "fal"]
   * ```
   */
  providers(): string[];
};

/** The registry's public surface — declared once in `../registry` and re-exported for this plugin's consumers. */
export type { RegistryApi } from "../registry";

/**
 * Domain context for the image API factory. `image` is a stateless facade
 * over `registry` (no `createState`), so `state` is the empty-object shape;
 * `require` is narrowed to the one dependency this plugin actually calls.
 *
 * @example
 * ```ts
 * export const createImageApi = (ctx: ImageContext): ImageApi => ({ ... });
 * ```
 */
export type ImageContext = PluginCtx<Config, Record<string, never>> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
};
