/**
 * @file promptGen plugin — type definitions (re-exports the contract).
 */
import type { PluginCtx } from "@moku-labs/core";
import type { RegistryApi, registryPlugin } from "../registry";
import type { PromptGenRequest, PromptGenResult } from "./contract";

export type { PromptGenHandler, PromptGenRequest, PromptGenResult } from "./contract";

/**
 * promptGen plugin configuration.
 *
 * @example
 * ```ts
 * const config: Config = { defaultProvider: "openai" };
 * ```
 */
export type Config = {
  /** Provider used when a request doesn't name one. Default: "openai". */
  defaultProvider: string;
};

/** The registry's public surface — declared once in `../registry` and re-exported for this plugin's consumers. */
export type { RegistryApi } from "../registry";

/**
 * Domain context for the promptGen API factory. `promptGen` is a stateless
 * facade over `registry` (no `createState`), so `state` is the empty-object
 * shape; `require` is narrowed to the one dependency this plugin actually
 * calls.
 *
 * @example
 * ```ts
 * export const createPromptGenApi = (ctx: PromptGenContext): PromptGenApi => ({ ... });
 * ```
 */
export type PromptGenContext = PluginCtx<Config, Record<string, never>> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
};

/**
 * Public API surface of the `promptGen` plugin, exposed as `app.promptGen`.
 *
 * @example
 * ```ts
 * const result = await app.promptGen.generate({ prompt: "Describe a sunset." });
 * ```
 */
export type PromptGenApi = {
  /**
   * One-off text generation — resolves the configured (or requested)
   * provider, performs the plugin's one audited cast to `PromptGenHandler`,
   * and executes it immediately. NOT journaled: this is the direct facade
   * path, not the durable path — use `app.runner.run()` for resumable,
   * progress-tracked execution.
   *
   * @param request - The prompt-gen request.
   * @param opts - Optional abort signal and provider override.
   * @param opts.signal - Optional abort signal to cancel the request.
   * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
   * @returns The generated text, cost, and metadata.
   * @example
   * ```ts
   * // One caption outside any run: nothing is journaled, so a crash loses it.
   * const { text, costUsd } = await app.promptGen.generate({ prompt: "Caption a sunset shot in five words." });
   * // text: the openai reply, costUsd: its usage priced from the openai table
   * await app.promptGen.generate({ prompt: "hi" }, { provider: "missing" }); // throws: No prompt-gen provider named "missing"
   * ```
   */
  generate(
    request: PromptGenRequest,
    opts?: { signal?: AbortSignal; provider?: string }
  ): Promise<PromptGenResult>;
  /**
   * Cost estimate without executing.
   *
   * @param request - The prompt-gen request to estimate.
   * @param opts - Optional provider override.
   * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
   * @returns The estimated cost in USD.
   * @example
   * ```ts
   * // Price a prompt before sending it; the default openai handler uses gpt-4o-mini.
   * app.promptGen.estimate({ prompt: "Describe a sunset over the ocean." }); // { usd: 0.00000675 }
   * ```
   */
  estimate(request: PromptGenRequest, opts?: { provider?: string }): { usd: number };
  /**
   * Registered prompt-gen providers.
   *
   * @returns Provider names in registration order (first = task default).
   * @example
   * ```ts
   * // List the names `opts.provider` accepts, for a provider picker.
   * app.promptGen.providers(); // ["openai"]
   * ```
   */
  providers(): string[];
};
