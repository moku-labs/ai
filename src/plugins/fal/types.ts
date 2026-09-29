/**
 * @file fal provider plugin — types (Config/State/API) and the domain
 * context type shared by `api.ts`, `upload.ts` and `video/handler.ts`.
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import type { PluginCtx } from "@moku-labs/core";
import type { RegistryApi, registryPlugin } from "../registry";
import type { VideoFile, VideoRequest } from "../video/contract";
import type { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "./errors";

/**
 * A request image, end frame or ref at estimate time: a resolved file, or
 * still the build-file reference the runner resolves before submit (the
 * runner estimates the unresolved request).
 *
 * @example
 * ```ts
 * const input: EstimateInput = { $ref: "s01.key" };
 * ```
 */
export type EstimateInput = VideoFile | { $ref: string } | { $file: string };

/**
 * A video request at estimate time: its first frame, end frame and refs may
 * still be build-file references. Every `VideoRequest` is one.
 *
 * @example
 * ```ts
 * const request: EstimateRequest = {
 *   model: "minimax-h3-max-i2v", prompt: "p", image: { $ref: "s01.key" }, endImage: { $ref: "s01.end" }
 * };
 * ```
 */
export type EstimateRequest = Omit<VideoRequest, "image" | "endImage" | "refs"> & {
  /** First frame, resolved or not. */
  image?: EstimateInput;
  /** End frame, resolved or not. It does not change the price. */
  endImage?: EstimateInput;
  /** Refs, resolved or not. */
  refs?: EstimateInput[];
};

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
  /** Price overrides keyed by `<alias>`, `<alias>@<resolution>`, `<alias>+audio` (USD/s) or a `<alias>#ref*` surcharge key. Default: {}. */
  priceOverrides: Record<string, number>;
};

/**
 * fal plugin state: the effective price table, computed once at first use
 * (bundled prices merged with `config.priceOverrides`), and the URLs of the
 * files this process already put in fal storage.
 */
export type State = {
  /** Effective price table (bundled prices merged with config.priceOverrides), computed once at first use. */
  prices: Record<string, number> | null;
  /**
   * fal storage URLs of files uploaded by this process, keyed `storage:<mime>:<sha256 of the bytes>`.
   * Only storage URLs are kept, never a data-URI fallback. Cleared on `app.stop()`.
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
 * The provider error classes and the retryable class's hint, declared in `./errors`.
 * Re-exported here as types only; the values ship as `FalErrors` from the package root.
 */
export type {
  FlaggedProviderError,
  RetryableProviderError,
  RetryHint,
  TerminalProviderError
} from "./errors";

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
 */
export type FalContext = PluginCtx<Config, State> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
  /** Resolved-environment accessor — reads the key at request time, never stores it. */
  env: EnvApi;
  /** Structured logger — receives ids, status codes and error classes only (never prompts or keys). */
  log: LogApi;
};
