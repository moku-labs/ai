/**
 * @file elevenlabs provider plugin — types (Config/State/API), the
 * runner-compatible provider error taxonomy, and the domain context type
 * shared by `api.ts` and `voiceover/handler.ts`.
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import type { PluginCtx } from "@moku-labs/core";
import type { registryPlugin } from "../registry";

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
  /** Price-per-character overrides by model (merged over the bundled table). Default: {}. */
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
 * registered `VoiceoverHandler` (spec/10), consumed through `app.voiceover`
 * and `app.runner`.
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
   * @returns Whether the provider is configured (an API key is present, without throwing) and the models known to the effective price table.
   */
  info(): { provider: "elevenlabs"; configured: boolean; models: string[] };
};

/**
 * Structural retry hint accepted by {@link RetryableProviderError}'s
 * constructor: a subset of the runner's own `ProviderErrorHint`
 * (`src/plugins/runner/types.ts`), deliberately NOT imported (no
 * cross-plugin type import; spec/10) — matched field-for-field so
 * `runner/retry.ts`'s `classifyError` buckets instances correctly by shape
 * alone.
 */
type RetryHint = {
  /** HTTP status code, when the failure came from an HTTP response (5xx or 429). */
  status?: number | undefined;
  /** Explicit classification hint for a non-HTTP retryable failure. */
  kind?: "timeout" | "network" | undefined;
  /** Provider-supplied Retry-After delay, ms. */
  retryAfterMs?: number | undefined;
};

/**
 * Retryable transport/provider failure: HTTP 5xx, HTTP 429 (with an
 * optional `Retry-After` hint), a request timeout, or a network-level
 * failure. Carries the structural fields `runner/retry.ts`'s
 * `classifyError` reads (`status`/`kind`/`retryAfterMs`) so instances are
 * bucketed as retryable without any cross-plugin error-class import.
 */
export class RetryableProviderError extends Error {
  readonly status: number | undefined;
  readonly kind: "timeout" | "network" | undefined;
  readonly retryAfterMs: number | undefined;

  /**
   * Creates a retryable provider error.
   *
   * @param message - Redacted human-readable message (never request text or response bodies).
   * @param hint - The structural classification hint (`status` for an HTTP code, `kind` for timeout/network, `retryAfterMs` for a provider-supplied delay).
   * @example
   * ```ts
   * throw new RetryableProviderError("[ai] ElevenLabs rate-limited the request.", {
   *   status: 429,
   *   retryAfterMs: 2_000
   * });
   * ```
   */
  constructor(message: string, hint: RetryHint) {
    super(message);
    this.name = "RetryableProviderError";
    this.status = hint.status;
    this.kind = hint.kind;
    this.retryAfterMs = hint.retryAfterMs;
  }
}

/**
 * Deterministic 4xx failure (excluding 429) — never retried. Carries the
 * `status` field `runner/retry.ts`'s `classifyError` reads to bucket it as
 * `"http-4xx"` (terminal).
 */
export class TerminalProviderError extends Error {
  readonly status: number;

  /**
   * Creates a terminal provider error.
   *
   * @param message - Redacted human-readable message (never request text or response bodies).
   * @param status - The HTTP status code that caused the failure.
   * @example
   * ```ts
   * throw new TerminalProviderError("[ai] ElevenLabs rejected the request (HTTP 400).", 400);
   * ```
   */
  constructor(message: string, status: number) {
    super(message);
    this.name = "TerminalProviderError";
    this.status = status;
  }
}

/**
 * Content-policy rejection — terminal `flagged` state, never re-queued.
 * Carries `kind: "content-policy"`, the field `runner/retry.ts`'s
 * `classifyError` reads to bucket it as `"content-policy"`.
 */
export class FlaggedProviderError extends Error {
  readonly kind: "content-policy" = "content-policy";

  /**
   * Creates a content-policy provider error.
   *
   * @param message - Redacted human-readable message (never request text or response bodies).
   * @example
   * ```ts
   * throw new FlaggedProviderError("[ai] ElevenLabs rejected the request for content-policy reasons.");
   * ```
   */
  constructor(message: string) {
    super(message);
    this.name = "FlaggedProviderError";
  }
}

/**
 * Public surface of the `registry` plugin (`app.registry`), redeclared here
 * because `registry` is Nano tier and ships no `types.ts` of its own. This
 * mirrors its real inferred API exactly, so `ctx.require(registryPlugin)`
 * can be typed inside this plugin's domain files instead of widening to
 * `unknown` (spec/09 R9 — the shape is derivable from a known, documented
 * dependency contract). Matches the redeclaration in translate/promptGen/
 * voiceover/runner's own `types.ts` (the same Nano `registry` dependency).
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
 * Domain context shared by `api.ts` (`info()`) and `voiceover/handler.ts`
 * (`estimate()`/`execute()`) — the framework's `PluginCtx` helper supplies
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
