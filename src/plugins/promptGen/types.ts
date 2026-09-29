/**
 * @file promptGen plugin — type definitions (re-exports the contract).
 */
import type { LogApi } from "@moku-labs/common";
import type { PluginCtx } from "@moku-labs/core";
import type { LimitsApi } from "../limits/types";
import type { RegistryApi, registryPlugin } from "../registry";
import type { PromptGenRequest, PromptGenResult } from "./contract";

export type { PromptGenHandler, PromptGenRequest, PromptGenResult } from "./contract";

/**
 * promptGen plugin configuration.
 *
 * @example
 * ```ts
 * createApp({ pluginConfigs: { promptGen: { defaultProvider: "claude", fallback: ["codex", "openai"] } } });
 * ```
 */
export type Config = {
  /** Provider used when a request doesn't name one. Default: "openai". */
  defaultProvider: string;
  /** Providers tried in order when the chosen one is unavailable. Default: []. */
  fallback: string[];
};

/** The registry's public surface — declared once in `../registry` and re-exported for this plugin's consumers. */
export type { RegistryApi } from "../registry";

/**
 * Domain context for the promptGen API factory. `promptGen` is a stateless
 * facade over `registry` (no `createState`), so `state` is the empty-object
 * shape; `require` is narrowed to the one dependency this plugin actually
 * calls; `log` and `limits` are the injected core APIs it uses.
 */
export type PromptGenContext = PluginCtx<Config, Record<string, never>> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
  /** Structured logger: one warn per provider switch, never the prompt. */
  log: LogApi;
  /** Per-lane admission control: `generate` waits for `prompt-gen/<provider>/default` per attempt. */
  limits: LimitsApi;
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
   * One-off text generation — walks the chain `[opts.provider ??
   * config.defaultProvider, ...config.fallback]` (duplicates tried once) and
   * returns the first answer. It moves to the next provider only when the
   * current one is unavailable (`isPromptGenUnavailable`, or a breaker-open
   * lane), logging `warn("prompt-gen:fallback", { from, to, reason })`; any
   * other error and an abort are rethrown at once. Each attempt waits for the
   * lane `prompt-gen/<provider>/default` in `ctx.limits` and releases it when
   * the attempt settles; outcomes are never reported. NOT journaled: this is
   * the direct facade path, not the durable path — use `app.runner.run()` for
   * resumable, progress-tracked execution.
   *
   * @param request - The prompt-gen request.
   * @param opts - Optional abort signal and provider override.
   * @param opts.signal - Optional abort signal; cancels the lane wait and the request.
   * @param opts.provider - Provider override for the head of the chain; defaults to `config.defaultProvider`.
   * @returns The generated text and cost; `meta.provider` names the provider that answered.
   * @throws {Error} The pinned unknown-provider error when the head of the chain is unregistered
   *   (later unregistered names are skipped with a warn), the first non-unavailable error,
   *   or the last error when every provider is unavailable.
   * @example
   * ```ts
   * // One caption outside any run: nothing is journaled, so a crash loses it.
   * const { text, costUsd } = await app.promptGen.generate({ prompt: "Caption a sunset shot in five words." });
   * // text: the openai reply, meta.provider: "openai"
   * // With { defaultProvider: "claude", fallback: ["codex"] } and claude not logged in:
   * await app.promptGen.generate({ prompt: "ok?" }); // meta.provider: "codex", one prompt-gen:fallback warn
   * ```
   */
  generate(
    request: PromptGenRequest,
    opts?: { signal?: AbortSignal; provider?: string }
  ): Promise<PromptGenResult>;
  /**
   * Cost estimate without executing. Resolves the head of the chain like
   * `generate` and asks that provider only: nothing runs, so there is no
   * fallback and no lane.
   *
   * @param request - The prompt-gen request to estimate.
   * @param opts - Optional provider override.
   * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
   * @returns The estimated cost in USD.
   * @throws {Error} The pinned unknown-provider error when that provider is unregistered.
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
