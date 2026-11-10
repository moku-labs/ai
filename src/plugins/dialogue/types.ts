/**
 * @file dialogue plugin — type definitions (re-exports the contract, plus the
 * plugin's config, public API, and domain context types).
 */
import type { PluginCtx } from "@moku-labs/core";
import type { RegistryApi, registryPlugin } from "../registry";
import type { DialogueRequest, DialogueResult } from "./contract";

export type {
  DialogueHandler,
  DialogueLine,
  DialogueLineTiming,
  DialogueRequest,
  DialogueResult,
  DialogueSettings
} from "./contract";

/**
 * dialogue plugin configuration: the provider the facade uses by default.
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
 * Public API surface of the `dialogue` plugin, exposed as `app.dialogue`.
 *
 * @example
 * ```ts
 * const scene = await app.dialogue.generate({
 *   lines: [{ id: "signAlice", text: "[tense] I never signed it!", voice: "TPIitICAZ8CqlGZ81AKm" }]
 * });
 * ```
 */
export type DialogueApi = {
  /**
   * One-off direct generation: resolves the provider's handler and calls its
   * `execute` once. NOT journaled: prefer `app.runner.run()` for resumability.
   *
   * @param request - The dialogue request.
   * @param opts - Optional provider override and abort signal.
   * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
   * @param opts.signal - Abort signal; passed to the provider's `execute`.
   * @returns The whole scene plus one output per line.
   * @throws {Error} `[ai] No dialogue provider named "<name>" is registered.` when the
   * provider is unregistered or its handler is malformed.
   * @example
   * ```ts
   * // Render a two-voice scene for a prototype, outside the runner.
   * const scene = await app.dialogue.generate({
   *   model: "eleven_v4",
   *   language: "ru",
   *   seed: 7,
   *   lines: [
   *     { id: "signAlice", text: "[tense] Я ничего не подписывала!", voice: "TPIitICAZ8CqlGZ81AKm" },
   *     { id: "signDaniel", text: "[bitterly] Ты давно здесь не живёшь, Элис.", voice: "6A9D8WSMm4rFsg2DWFeE" }
   *   ]
   * });
   * await Bun.write("scene.mp3", scene.audio);
   * for (const out of scene.outputs.slice(1)) await Bun.write(`${out.name}.mp3`, out.bytes);
   * ```
   */
  generate(
    request: DialogueRequest,
    opts?: { provider?: string; signal?: AbortSignal }
  ): Promise<DialogueResult>;
  /**
   * Cost estimate without executing — calls the same handler `estimate()` the
   * runner's budget gate uses.
   *
   * @param request - The dialogue request to estimate.
   * @param opts - Optional provider override.
   * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
   * @returns The estimated cost in USD.
   * @throws {Error} The same two-line unknown-provider error as `generate`.
   * @example
   * ```ts
   * // Check what a scene costs before adding it to a build file.
   * const { usd } = app.dialogue.estimate({ lines: [{ text: "Hi", voice: "v1" }] });
   * ```
   */
  estimate(request: DialogueRequest, opts?: { provider?: string }): { usd: number };
  /**
   * Registered dialogue providers, in registration order.
   *
   * @returns Registered provider names for the "dialogue" task.
   * @example
   * ```ts
   * // Pick a provider for `opts.provider`: first registered is first in the list.
   * app.dialogue.providers(); // => ["elevenlabs"]
   * ```
   */
  providers(): string[];
};

/** The registry's public surface — declared once in `../registry` and re-exported for this plugin's consumers. */
export type { RegistryApi } from "../registry";

/**
 * Domain context for the dialogue API factory. Stateless facade over `registry`,
 * so `state` is the empty-object shape; `require` is narrowed to the registry.
 */
export type DialogueContext = PluginCtx<Config, Record<string, never>> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
};
