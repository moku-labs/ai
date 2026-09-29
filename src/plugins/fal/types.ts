/**
 * @file fal provider plugin — types (Config/State/API), the runner-compatible
 * provider error taxonomy, and the domain context type shared by `api.ts`,
 * `client/`, `log.ts` and the four task handlers (video, image, prompt-gen, music).
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import type { PluginCtx } from "@moku-labs/core";
import type { RegistryApi, registryPlugin } from "../registry";

/** The estimate-time request types — declared once in `../video/contract` and re-exported for `Fal.*` consumers. */
export type { EstimateInput, EstimateRequest } from "../video/contract";

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
 * fal plugin configuration: API key env var, queue, sync and storage URLs,
 * upload mode, timeouts, default image and LLM models, the in-process job
 * wait, price overrides and the opt-in request log. Flat keys only (shallow merge).
 *
 * @example
 * ```ts
 * createApp({
 *   pluginConfigs: {
 *     fal: { imageDefaultModel: "nano-banana-pro", requestLog: ".moku/fal.jsonl", priceOverrides: { "image:gpt-image-2.5": 0.07 } }
 *   }
 * });
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
  /**
   * Price overrides, one table for every task. Video: `<alias>`, `<alias>@<resolution>`, `<alias>+audio`
   * (USD/s) or a `<alias>#ref*` surcharge key. Image: `image:<alias>` or `image:<alias>@<resolution>` (USD/image).
   * Music: `music:<alias>` (USD per started minute or per generation). prompt-gen: `llm:<id>#in` /
   * `llm:<id>#out` (USD per M tokens). Default: {}.
   */
  priceOverrides: Record<string, number>;
  /**
   * Sync endpoint base; prompt-gen POSTs `<runUrl>/openrouter/router/openai/v1/chat/completions`.
   * Default: "https://fal.run".
   *
   * @example
   * ```ts
   * createApp({ pluginConfigs: { fal: { runUrl: "https://fal.run" } } });
   * ```
   */
  runUrl: string;
  /**
   * Image model used when `ImageRequest.model` is omitted. Default: "gpt-image-2.5".
   *
   * @example
   * ```ts
   * createApp({ pluginConfigs: { fal: { imageDefaultModel: "nano-banana-pro" } } });
   * ```
   */
  imageDefaultModel: string;
  /**
   * OpenRouter model id used when `PromptGenRequest.model` is omitted or `"default"`.
   * Default: "anthropic/claude-opus-5.5".
   *
   * @example
   * ```ts
   * createApp({ pluginConfigs: { fal: { llmDefaultModel: "google/gemini-3.8-flash" } } });
   * ```
   */
  llmDefaultModel: string;
  /**
   * Status-check cadence, ms, of the in-process wait of image and music `execute`. Default: 2000.
   *
   * @example
   * ```ts
   * createApp({ pluginConfigs: { fal: { pollMs: 5000 } } });
   * ```
   */
  pollMs: number;
  /**
   * The in-process wait gives up after this many ms (retryable `timeout`); the fal job keeps
   * running and stays adoptable through `poll`. Default: 900_000.
   *
   * @example
   * ```ts
   * createApp({ pluginConfigs: { fal: { jobTimeoutMs: 1_800_000 } } });
   * ```
   */
  jobTimeoutMs: number;
  /**
   * JSONL request log path, relative to the working directory: one line per billable request of
   * every task. Off when undefined. Default: undefined.
   *
   * @example
   * ```ts
   * createApp({ pluginConfigs: { fal: { requestLog: ".moku/log/fal.jsonl" } } });
   * ```
   */
  requestLog: string | undefined;
};

/**
 * fal plugin state: the effective price table of every task, computed once at
 * first use (bundled prices merged with `config.priceOverrides`), and the URLs
 * of the files this process already put in fal storage.
 */
export type State = {
  /** Effective price table of every task (bundled prices merged with config.priceOverrides), computed once at first use. */
  prices: Record<string, number> | null;
  /**
   * fal storage URLs of files uploaded by this process, keyed `storage:<mime>:<sha256 of the bytes>`,
   * shared by every task. Only storage URLs are kept, never a data-URI fallback. Kept for the life of
   * the process: `app.stop()` does not clear it.
   */
  uploads: Map<string, string>;
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
 * The four tasks this plugin serves, as `app.fal.models(task)` names them.
 *
 * @example
 * ```ts
 * const task: FalTask = "prompt-gen";
 * ```
 */
export type FalTask = "video" | "image" | "prompt-gen" | "music";

/**
 * One model of one task with its effective price. prompt-gen is priced per M tokens,
 * every other task per billing unit. Narrow on `"inputPerM" in info.price`.
 *
 * @example
 * ```ts
 * const info: FalModelInfo = { id: "stable-audio-2.5", price: { usd: 0.2, per: "generation" } };
 * ```
 */
export type FalModelInfo =
  | { id: string; price: { inputPerM: number; outputPerM: number } }
  | { id: string; price: { usd: number; per: "second" | "image" | "minute" | "generation" } };

/**
 * A resolved local file any task uploads. `VideoFile` and `ImageFile` have this shape.
 *
 * @example
 * ```ts
 * const still: LocalFile = { path: "out/s01.key.png", mimeType: "image/png", hash: "sha256:ab12" };
 * ```
 */
export type LocalFile = {
  /** Path to the file bytes. */
  path: string;
  /** MIME type of the file. */
  mimeType: string;
  /** Content hash of the file bytes. */
  hash: string;
};

/**
 * Public API surface of the `fal` plugin, exposed as `app.fal`. A thin
 * observability surface — the real capability surface is the four registered
 * handlers, consumed through `app.video`, `app.image`, `app.promptGen`,
 * `app.music` and `app.runner`.
 *
 * @example
 * ```ts
 * app.fal.info(); // => { provider: "fal", configured: true, models: [...] }
 * app.fal.models("music").length; // => 2
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
  /**
   * The models this plugin accepts for one task, with their effective price (bundled merged with
   * `priceOverrides`), in catalog order. No network, no key. Video and image list the price at the
   * model's default resolution (video: audio off, no refs).
   *
   * @param task - One of the four fal tasks.
   * @returns One entry per model; the `price` shape follows the task's billing unit.
   * @throws {Error} `[ai] Unknown fal task "x".` for any other string at runtime.
   * @example
   * ```ts
   * // A picker lists prompt-gen models with their per-M-token prices.
   * app.fal.models("prompt-gen")[0]; // => { id: "anthropic/claude-opus-5.5", price: { inputPerM: 4, outputPerM: 20 } }
   * app.fal.models("music"); // => [{ id: "elevenlabs-music-v2.5", price: { usd: 0.8, per: "minute" } }, { id: "stable-audio-2.5", price: { usd: 0.2, per: "generation" } }]
   * app.fal.models("image")[0]; // => { id: "nano-banana-pro", price: { usd: 0.15, per: "image" } }
   * app.fal.models("video")[0]; // => { id: "seedance-2.5", price: { usd: 0.473, per: "second" } }
   * ```
   */
  models(task: FalTask): FalModelInfo[];
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
  /** HTTP status code, when the failure came from an HTTP response (5xx or 429). */
  readonly status: number | undefined;
  /** Explicit classification hint for a non-HTTP retryable failure. */
  readonly kind: "timeout" | "network" | undefined;
  /** Provider-supplied Retry-After delay, ms. */
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
  /** The HTTP status code that caused the failure. */
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
  /** Classification the runner reads to bucket the failure as `"content-policy"`. */
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
 * Domain context shared by `api.ts`, `prices.ts`, `log.ts`, `client/` and the
 * task handlers — `PluginCtx` supplies `config`/`state`/`emit`;
 * `require` is narrowed to the registry, and `env`/`log` are the injected
 * core APIs this plugin reads the key and logs redacted diagnostics through.
 */
export type FalContext = PluginCtx<Config, State> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
  /** Resolved-environment accessor — reads the key at request time, never stores it. */
  env: EnvApi;
  /** Structured logger — receives ids, status codes and error classes only (never prompts or keys). */
  log: LogApi;
};
