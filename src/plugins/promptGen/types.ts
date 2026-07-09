/**
 * @file promptGen plugin — type definitions (re-exports the contract).
 */
import type { PluginCtx } from "@moku-labs/core";
import type { registryPlugin } from "../registry";
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

/**
 * Public surface of the `registry` plugin (`app.registry`), redeclared here
 * because `registry` is Nano tier and ships no `types.ts` of its own. This
 * mirrors its real inferred API exactly, so `ctx.require(registryPlugin)`
 * can be typed inside this plugin's domain files instead of widening to
 * `unknown` (spec/09 R9 — the shape is derivable from a known, documented
 * dependency contract).
 *
 * @example
 * ```ts
 * const registry: RegistryApi = ctx.require(registryPlugin);
 * registry.providers("prompt-gen");
 * ```
 */
export type RegistryApi = {
  /**
   * Registers a handler for a (task, provider) pair.
   *
   * @param task - Task key, e.g. "prompt-gen".
   * @param provider - Provider name, e.g. "openai".
   * @param handler - Opaque handler; narrowed by the owning task plugin.
   */
  register(task: string, provider: string, handler: unknown): void;
  /**
   * Resolves a registered handler.
   *
   * @param task - Task key.
   * @param provider - Provider name.
   * @returns The registered handler, or undefined when unregistered.
   */
  resolve(task: string, provider: string): unknown;
  /**
   * Provider names registered for a task, in registration order.
   *
   * @param task - Task key.
   * @returns Provider names, first-registered first (the task default).
   */
  providers(task: string): string[];
  /**
   * All registered task names.
   *
   * @returns Task names in registration order.
   */
  tasks(): string[];
};

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
   */
  estimate(request: PromptGenRequest, opts?: { provider?: string }): { usd: number };
  /**
   * Registered prompt-gen providers.
   *
   * @returns Provider names in registration order (first = task default).
   */
  providers(): string[];
};
