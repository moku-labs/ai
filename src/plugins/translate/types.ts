/**
 * @file translate plugin — type definitions (re-exports the contract).
 */
import type { PluginCtx } from "@moku-labs/core";
import type { registryPlugin } from "../registry";
import type { TranslateRequest, TranslateResult } from "./contract";

export type { TranslateHandler, TranslateRequest, TranslateResult } from "./contract";

/**
 * translate plugin configuration.
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
 * registry.providers("translate");
 * ```
 */
export type RegistryApi = {
  /**
   * Registers a handler for a (task, provider) pair.
   *
   * @param task - Task key, e.g. "translate".
   * @param provider - Provider name, e.g. "openai".
   * @param handler - Opaque handler; narrowed by the owning task plugin.
   * @returns Nothing.
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
 * Domain context for the translate API factory. `translate` is a stateless
 * facade over `registry` (no `createState`), so `state` is the empty-object
 * shape; `require` is narrowed to the one dependency this plugin actually
 * calls.
 *
 * @example
 * ```ts
 * export const createTranslateApi = (ctx: TranslateContext): TranslateApi => ({ ... });
 * ```
 */
export type TranslateContext = PluginCtx<Config, Record<string, never>> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
};

/**
 * Public API surface of the `translate` plugin, exposed as `app.translate`.
 *
 * @example
 * ```ts
 * const result = await app.translate.generate({ text: "Hello", targetLang: "es" });
 * ```
 */
export type TranslateApi = {
  /**
   * One-off direct translation — resolves the configured (or requested)
   * provider, performs the plugin's one audited cast to `TranslateHandler`,
   * and executes it immediately. NOT journaled: this is the direct facade
   * path, not the durable path — use `app.runner.run()` for resumable,
   * progress-tracked execution.
   *
   * @param request - The translate request.
   * @param opts - Optional abort signal and provider override.
   * @param opts.signal - Optional abort signal to cancel the request.
   * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
   * @returns The translated text, cost, and metadata.
   */
  generate(
    request: TranslateRequest,
    opts?: { signal?: AbortSignal; provider?: string }
  ): Promise<TranslateResult>;
  /**
   * Cost estimate without executing.
   *
   * @param request - The translate request to estimate.
   * @param opts - Optional provider override.
   * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
   * @returns The estimated cost in USD.
   */
  estimate(request: TranslateRequest, opts?: { provider?: string }): { usd: number };
  /**
   * Registered translate providers.
   *
   * @returns Provider names in registration order (first = task default).
   */
  providers(): string[];
};
