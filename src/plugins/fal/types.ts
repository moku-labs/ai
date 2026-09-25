/**
 * @file fal provider plugin — types (Config/State/API), the runner-compatible
 * provider error taxonomy, and the domain context type shared by `api.ts`,
 * `upload.ts` and `video/handler.ts`.
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import type { PluginCtx } from "@moku-labs/core";
import type { RegistryApi, registryPlugin } from "../registry";

/**
 * How local input files reach fal: `"storage"` uploads them to fal storage
 * and sends the returned URL; `"data-uri"` inlines them as base64 data URIs.
 *
 * @example
 * ```ts
 * const mode: UploadMode = "storage";
 * ```
 */
export type UploadMode = "storage" | "data-uri";

/**
 * fal plugin configuration: API key env var, queue + storage URLs, upload
 * mode, request timeout, and price overrides.
 *
 * @example
 * ```ts
 * const config: Config = {
 *   apiKeyEnv: "FAL_KEY",
 *   queueUrl: "https://queue.fal.run",
 *   uploadUrl: "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3",
 *   upload: "storage",
 *   timeoutMs: 60_000,
 *   priceOverrides: {}
 * };
 * ```
 */
export type Config = {
  /** Env var name holding the fal key — resolved via ctx.env at request time, never stored. Default: "FAL_KEY". */
  apiKeyEnv: string;
  /** Queue base URL. Default: "https://queue.fal.run". */
  queueUrl: string;
  /** Storage upload initiate URL. Default: "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3". */
  uploadUrl: string;
  /** How local files reach fal. Default: "storage". */
  upload: UploadMode;
  /** Per HTTP request timeout, ms. Default: 60_000. */
  timeoutMs: number;
  /** USD-per-second overrides keyed by `<alias>`, `<alias>@<resolution>` or `<alias>+audio`. Default: {}. */
  priceOverrides: Record<string, number>;
};

/**
 * fal plugin state: the effective price table, computed once at first use
 * (bundled prices merged with `config.priceOverrides`).
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
 * What `app.fal.info()` returns: provider id, whether the key is present,
 * and the model aliases this plugin accepts.
 *
 * @example
 * ```ts
 * const info: FalInfo = { provider: "fal", configured: true, models: ["seedance-2.5"] };
 * ```
 */
export type FalInfo = {
  /** Always "fal". */
  provider: "fal";
  /** Whether the configured key env var is present. */
  configured: boolean;
  /** Accepted model aliases, in catalog order. */
  models: string[];
};

/**
 * Public API surface of the `fal` plugin, exposed as `app.fal`. A thin
 * observability surface — the real capability surface is the registered
 * `VideoHandler`, consumed through `app.video` and `app.runner`.
 *
 * @example
 * ```ts
 * app.fal.info(); // => { provider: "fal", configured: true, models: [...] }
 * ```
 */
export type FalApi = {
  /**
   * Provider health/info for `moku status` + docs.
   *
   * @returns Whether the key is present (never throws) and the accepted model aliases.
   * @example
   * ```ts
   * // Before a video run, check FAL_KEY is set and the shot's model alias exists.
   * const { configured, models } = app.fal.info();
   * // configured: false without the key, models.includes("minimax-h3"): true
   * ```
   */
  info(): FalInfo;
};

/**
 * Structural retry hint accepted by {@link RetryableProviderError}'s
 * constructor: a subset of the runner's own `ProviderErrorHint`, matched
 * field-for-field (no cross-plugin type import) so `runner/retry.ts`'s
 * `classifyError` buckets instances by shape alone.
 *
 * @example
 * ```ts
 * const hint: RetryHint = { status: 429, retryAfterMs: 2000 };
 * ```
 */
export type RetryHint = {
  /** HTTP status code, when the failure came from an HTTP response (5xx or 429). */
  status?: number | undefined;
  /** Explicit classification hint for a non-HTTP retryable failure. */
  kind?: "timeout" | "network" | undefined;
  /** Provider-supplied Retry-After delay, ms. */
  retryAfterMs?: number | undefined;
};

/**
 * Retryable transport/provider failure: HTTP 5xx, HTTP 429 (with an optional
 * `Retry-After` hint), a request timeout, a network failure, or a fal job
 * that finished with a transient `error_type`. Carries the structural fields
 * the runner's `classifyError` reads (`status`/`kind`/`retryAfterMs`).
 *
 * @example
 * ```ts
 * throw new RetryableProviderError("[ai] fal returned HTTP 503.", { status: 503 });
 * ```
 */
export class RetryableProviderError extends Error {
  readonly status: number | undefined;
  readonly kind: "timeout" | "network" | undefined;
  readonly retryAfterMs: number | undefined;

  /**
   * Creates a retryable provider error.
   *
   * @param message - Human-readable message (never the key or the prompt).
   * @param hint - The structural classification hint.
   * @example
   * ```ts
   * new RetryableProviderError("[ai] fal rate-limited the request.", { status: 429, retryAfterMs: 2000 });
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
 * Deterministic failure (a 4xx other than 429, or a fal job that finished
 * with a non-transient error) — never retried. Carries the `status` field
 * the runner's `classifyError` reads to bucket it as `"http-4xx"`.
 *
 * @example
 * ```ts
 * throw new TerminalProviderError("[ai] fal rejected the request (HTTP 400).", 400);
 * ```
 */
export class TerminalProviderError extends Error {
  readonly status: number;

  /**
   * Creates a terminal provider error.
   *
   * @param message - Human-readable message (never the key or the prompt).
   * @param status - The HTTP status code that caused the failure.
   * @example
   * ```ts
   * new TerminalProviderError("[ai] fal rejected the request (HTTP 401).", 401);
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
 * Carries `kind: "content-policy"`, the field the runner's `classifyError`
 * reads to bucket it as `"content-policy"`.
 *
 * @example
 * ```ts
 * throw new FlaggedProviderError("[ai] fal rejected the request for content-policy reasons.");
 * ```
 */
export class FlaggedProviderError extends Error {
  readonly kind: "content-policy" = "content-policy";

  /**
   * Creates a content-policy provider error.
   *
   * @param message - Human-readable message (never the key or the prompt).
   * @example
   * ```ts
   * new FlaggedProviderError("[ai] fal flagged the request (content policy).");
   * ```
   */
  constructor(message: string) {
    super(message);
    this.name = "FlaggedProviderError";
  }
}

/**
 * Any of this plugin's classified provider errors.
 *
 * @example
 * ```ts
 * const error: FalProviderError = new TerminalProviderError("[ai] fal rejected the request (HTTP 400).", 400);
 * ```
 */
export type FalProviderError =
  | RetryableProviderError
  | TerminalProviderError
  | FlaggedProviderError;

/** The registry's public surface — declared once in `../registry` and re-exported for this plugin's consumers. */
export type { RegistryApi } from "../registry";

/**
 * Domain context shared by `api.ts`, `prices.ts`, `upload.ts` and
 * `video/handler.ts` — `PluginCtx` supplies `config`/`state`/`emit`;
 * `require` is narrowed to the registry, and `env`/`log` are the injected
 * core APIs this plugin reads the key and logs redacted diagnostics through.
 *
 * @example
 * ```ts
 * export const createFalApi = (ctx: FalContext): FalApi => ({ ... });
 * ```
 */
export type FalContext = PluginCtx<Config, State> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
  /** Resolved-environment accessor — reads the key at request time, never stores it. */
  env: EnvApi;
  /** Structured logger — receives ids, status codes and error classes only (never prompts or keys). */
  log: LogApi;
};
