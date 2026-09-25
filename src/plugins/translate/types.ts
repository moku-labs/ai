/**
 * @file translate plugin — type definitions (re-exports the contract).
 */
import type { PluginCtx } from "@moku-labs/core";
import type { RegistryApi, registryPlugin } from "../registry";
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

/** The registry's public surface — declared once in `../registry` and re-exported for this plugin's consumers. */
export type { RegistryApi } from "../registry";

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
   * @example
   * ```ts
   * // Translate one subtitle line outside any run: nothing is journaled.
   * const { text, costUsd } = await app.translate.generate({ text: "Hello, world!", targetLang: "es" });
   * // text: the openai translation, costUsd: its usage priced from the openai table
   * await app.translate.generate({ text: "hi", targetLang: "es" }, { provider: "missing" }); // throws: No translate provider named "missing"
   * ```
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
   * @example
   * ```ts
   * // Price a line before translating it; the default openai handler uses gpt-4o-mini.
   * app.translate.estimate({ text: "Hello, world!", targetLang: "es" }); // { usd: 0.0000102 }
   * ```
   */
  estimate(request: TranslateRequest, opts?: { provider?: string }): { usd: number };
  /**
   * Registered translate providers.
   *
   * @returns Provider names in registration order (first = task default).
   * @example
   * ```ts
   * // List the names `opts.provider` accepts, for a provider picker.
   * app.translate.providers(); // ["openai"]
   * ```
   */
  providers(): string[];
};
