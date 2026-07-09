/**
 * @file voiceover plugin — type definitions (re-exports the contract, plus
 * the plugin's config, public API, and domain context types).
 */
import type { PluginCtx } from "@moku-labs/core";
import type { registryPlugin } from "../registry";
import type { VoiceoverRequest, VoiceoverResult } from "./contract";

export type { VoiceoverHandler, VoiceoverRequest, VoiceoverResult } from "./contract";

/**
 * voiceover plugin configuration: the provider used when a request doesn't
 * name one, and the default output format hint passed to providers when a
 * request doesn't specify one.
 *
 * @example
 * ```ts
 * const config: Config = { defaultProvider: "elevenlabs", defaultFormat: "mp3" };
 * ```
 */
export type Config = {
  /** Provider used when a request doesn't name one. Default: "elevenlabs". */
  defaultProvider: string;
  /** Default output format hint passed to providers. Default: "mp3". */
  defaultFormat: "mp3" | "wav" | "ogg";
};

/**
 * Public API surface of the `voiceover` plugin, exposed as `app.voiceover`.
 * A typed, one-off facade over the registry's opaque handler transport for
 * the "voiceover" task: providers register their `VoiceoverHandler` under
 * this task name, and this API resolves, audits, and dispatches to them.
 *
 * @example
 * ```ts
 * const result = await app.voiceover.generate({ text: "Hi", voice: "en-US-1" });
 * ```
 */
export type VoiceoverApi = {
  /**
   * One-off direct generation — resolves the named (or default) provider,
   * performs the one audited cast from the registry's opaque handler, and
   * executes it. NOT journaled: this bypasses the durable run ledger, so
   * it has no resumability or cost-ledger entry. Prefer `app.runner.run()`
   * for anything that needs resumability or durable cost tracking; use
   * `generate()` for scripts, tests, and interactive one-offs only.
   *
   * @param request - The voiceover request (text, voice, and optional params).
   * @param opts - Optional abort signal and provider override.
   * @param opts.signal - Optional abort signal to cancel the request.
   * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
   * @returns The generated audio result.
   * @example
   * ```ts
   * await app.voiceover.generate({ text: "Hi", voice: "en-US-1" }, { provider: "openai" });
   * ```
   */
  generate(
    request: VoiceoverRequest,
    opts?: { signal?: AbortSignal; provider?: string }
  ): Promise<VoiceoverResult>;
  /**
   * Cost estimate without executing — calls the same handler `estimate()`
   * the runner's budget gate uses, so a one-off estimate and a runner
   * budget check never disagree.
   *
   * @param request - The voiceover request to estimate.
   * @param opts - Optional provider override.
   * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
   * @returns The estimated cost in USD.
   * @example
   * ```ts
   * app.voiceover.estimate({ text: "Hi", voice: "en-US-1" }); // => { usd: 0.00006 }
   * ```
   */
  estimate(request: VoiceoverRequest, opts?: { provider?: string }): { usd: number };
  /**
   * Registered voiceover providers, in registration order (the first
   * registered provider is the task's implicit default).
   *
   * @returns Registered provider names for the "voiceover" task.
   * @example
   * ```ts
   * app.voiceover.providers(); // => ["elevenlabs", "openai"]
   * ```
   */
  providers(): string[];
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
 * registry.providers("voiceover");
 * ```
 */
export type RegistryApi = {
  /**
   * Registers a handler for a (task, provider) pair.
   *
   * @param task - Task key, e.g. "voiceover".
   * @param provider - Provider name, e.g. "elevenlabs".
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
 * Domain context for the voiceover API factory. `voiceover` is a stateless
 * facade over `registry` (no `createState`), so `state` is the empty-object
 * shape; `require` is narrowed to the one dependency this plugin actually
 * calls.
 *
 * @example
 * ```ts
 * export const createVoiceoverApi = (ctx: VoiceoverContext): VoiceoverApi => ({ ... });
 * ```
 */
export type VoiceoverContext = PluginCtx<Config, Record<string, never>> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
};
