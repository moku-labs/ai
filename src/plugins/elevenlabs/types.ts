/**
 * @file elevenlabs provider plugin — types (Config/State/API), type aliases
 * of the `errors.ts` provider error classes, and the domain
 * context type shared by `api.ts` and the per-task handlers.
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import type { PluginCtx } from "@moku-labs/core";
import type { RegistryApi, registryPlugin } from "../registry";
import type {
  FlaggedProviderError as FlaggedProviderErrorClass,
  RetryableProviderError as RetryableProviderErrorClass,
  TerminalProviderError as TerminalProviderErrorClass
} from "./errors";

/**
 * elevenlabs plugin configuration: API key env var, base URL, default
 * model, request timeout, and per-model price overrides.
 *
 * @example
 * ```ts
 * const config: Config = {
 *   apiKeyEnv: "ELEVENLABS_API_KEY",
 *   baseUrl: "https://api.elevenlabs.io",
 *   defaultModel: "eleven_multilingual_v2",
 *   timeoutMs: 60_000,
 *   priceOverrides: {}
 * };
 * ```
 */
export type Config = {
  /** Env var name holding the API key — resolved via ctx.env at request time, never stored. Default: "ELEVENLABS_API_KEY". */
  apiKeyEnv: string;
  /** API base URL. Default: "https://api.elevenlabs.io". */
  baseUrl: string;
  /** Default model. Default: "eleven_multilingual_v2". */
  defaultModel: string;
  /** Request timeout, ms. Default: 60_000. */
  timeoutMs: number;
  /**
   * Price overrides merged over the bundled table. Voice models are keyed by model id (USD per
   * character); sfx rows are keyed `sfx:<model>#second` (USD per started second) and
   * `sfx:<model>#auto` (USD for a model-picked length). Default: {}.
   */
  priceOverrides: Record<string, number>;
};

/**
 * elevenlabs plugin state: the effective price table, computed once at
 * first use (bundled prices merged with `config.priceOverrides`).
 *
 * @example
 * ```ts
 * const state: State = { prices: null };
 * ```
 */
export type State = {
  /** Effective price table (bundled prices merged with config.priceOverrides), computed once at first use. */
  prices: Record<string, number> | null;
};

/**
 * Public API surface of the `elevenlabs` plugin, exposed as `app.elevenlabs`.
 * A thin observability surface — the real capability surface is the
 * registered `VoiceoverHandler` and `SfxHandler` (spec/10), consumed through
 * `app.voiceover`, `app.sfx` and `app.runner`.
 *
 * @example
 * ```ts
 * app.elevenlabs.info(); // => { provider: "elevenlabs", configured: true, models: [...] }
 * ```
 */
export type ElevenlabsApi = {
  /**
   * Provider health/info for `moku status` + docs.
   *
   * @returns Whether the provider is configured (an API key is present, without throwing) and the voice models known to the effective price table (`sfx:` price rows are left out).
   * @example
   * ```ts
   * // Before a voiceover run, check ELEVENLABS_API_KEY is set; this call never throws.
   * const { configured, models } = app.elevenlabs.info();
   * // configured: false without the key, models: ["eleven_multilingual_v2", "eleven_turbo_v2_5", "eleven_flash_v2_5", "eleven_monolingual_v1"]
   * ```
   */
  info(): { provider: "elevenlabs"; configured: boolean; models: string[] };
};

/** The registry's public surface — declared once in `../registry` and re-exported for this plugin's consumers. */
export type { RegistryApi } from "../registry";

// Type aliases, not `export type { … } from "./errors"`: the .d.ts bundler turns a type-only
// class re-export back into `declare class`, so `Elevenlabs.X` would pass tsc as a value that is
// `undefined` at runtime. The classes ship as values in `ElevenlabsErrors` from the package root.
/** Instance type of the retryable provider error; the class is `ElevenlabsErrors.RetryableProviderError`. */
export type RetryableProviderError = RetryableProviderErrorClass;
/** Instance type of the terminal provider error; the class is `ElevenlabsErrors.TerminalProviderError`. */
export type TerminalProviderError = TerminalProviderErrorClass;
/** Instance type of the content-policy provider error; the class is `ElevenlabsErrors.FlaggedProviderError`. */
export type FlaggedProviderError = FlaggedProviderErrorClass;

/**
 * Domain context shared by `api.ts` (`info()`), `voiceover/handler.ts` and
 * `sfx/handler.ts` (`estimate()`/`execute()`) — the framework's `PluginCtx` helper supplies
 * `config`/`state`/`emit`; `require` is narrowed to the one declared
 * dependency (`registry`), and `env`/`log` are the injected core APIs this
 * plugin reads the API key and logs redacted failures through.
 *
 * @example
 * ```ts
 * export const createElevenlabsApi = (ctx: ElevenlabsContext): ElevenlabsApi => ({ ... });
 * ```
 */
export type ElevenlabsContext = PluginCtx<Config, State> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
  /** Resolved-environment accessor — reads the API key at request time, never stores it. */
  env: EnvApi;
  /** Structured logger — receives status codes + error classes only (never request text). */
  log: LogApi;
};
