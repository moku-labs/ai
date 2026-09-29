/**
 * @file apimodels provider plugin — types (Config/State/API), the
 * runner-compatible provider error taxonomy, and the domain context type
 * shared by `api.ts`, `upload.ts`, `assets.ts`, `prices.ts` and
 * `video/handler.ts`.
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import type { PluginCtx } from "@moku-labs/core";
import type { JournalApi } from "../journal/types";
import type { RegistryApi, registryPlugin } from "../registry";

/** The estimate-time request types — declared once in `../video/contract` and re-exported for `Apimodels.*` consumers. */
export type { EstimateInput, EstimateRequest } from "../video/contract";

/**
 * apimodels plugin configuration: API key env var, base URL, asset group
 * name, request timeout and price overrides. Flat plain data.
 *
 * @example
 * ```ts
 * createApp({ pluginConfigs: { apimodels: { assetGroup: "studio-cast", timeoutMs: 120_000 } } });
 * ```
 */
export type Config = {
  /** Env var holding the API key, read through ctx.env at request time, never stored. Default "APIMODELS_API_KEY". */
  apiKeyEnv: string;
  /** API base URL, no trailing slash. Default "https://api.apimodels.app/v1" (100 MB bodies). */
  baseUrl: string;
  /** Name of the asset group created lazily per account. Default "moku-ai". */
  assetGroup: string;
  /** Per-HTTP-request timeout, ms. Default 60_000. */
  timeoutMs: number;
  /** Price table entries that replace bundled ones wholesale per key (USD). Default {}. */
  priceOverrides: Record<string, number>;
};

/**
 * apimodels plugin state: the memoized price table, the process-wide
 * caches of uploads, asset ids and asset group ids, and the calls of those
 * three kinds still in flight, so concurrent submits share one call.
 */
export type State = {
  /** Merged price table (bundled + overrides), memoized on first use. */
  prices: Record<string, number> | null;
  /** Upload cache for the process: "file:<mime>:<VideoFile.hash>" → publicUrl. */
  uploads: Map<string, string>;
  /** Asset cache for the process, first tier: "<account>:<VideoFile.hash>" → "asset://…". */
  assets: Map<string, string>;
  /** Asset group id per account fingerprint, first tier. */
  groups: Map<string, string>;
  /** In-flight group creation per account, so concurrent submits share one POST /assets/groups. */
  groupsInFlight: Map<string, Promise<string>>;
  /** In-flight registration per "<account>:<hash>", so concurrent submits share one POST /assets. */
  assetsInFlight: Map<string, Promise<string>>;
  /** In-flight upload per upload key, so concurrent submits share one POST /files. */
  uploadsInFlight: Map<string, Promise<string>>;
  /** True once a "journal not open" skip was logged, so it logs once. */
  journalSkipLogged: boolean;
};

/**
 * What `app.apimodels.info()` returns: provider id, whether the key is set,
 * and the video aliases this plugin serves.
 *
 * @example
 * ```ts
 * const info: ApimodelsInfo = { provider: "apimodels", configured: true, models: ["seedance-2.5"] };
 * ```
 */
export type ApimodelsInfo = {
  /** Always "apimodels". */
  provider: "apimodels";
  /** Whether the configured key env var is set. */
  configured: boolean;
  /** Served video aliases, in catalog order. */
  models: string[];
};

/**
 * Public API surface of the `apimodels` plugin, exposed as `app.apimodels`.
 * The video work goes through the `video` task (`app.video.*`, runner build
 * files), never through this API.
 *
 * @example
 * ```ts
 * app.apimodels.info(); // => { provider: "apimodels", configured: true, models: [...] }
 * ```
 */
export type ApimodelsApi = {
  /**
   * Static facts about the provider: whether the key env var is set and which
   * video aliases it serves. No network call.
   *
   * @returns The provider id, whether the key is set, and the served aliases.
   * @example
   * ```ts
   * // Before switching a Seedance shot from fal to apimodels, check the key is set.
   * app.apimodels.info();
   * // { provider: "apimodels", configured: true, models: ["seedance-2.5", "seedance-2.5-ref", "seedance-2.0", "seedance-2.0-ref"] }
   * ```
   */
  info(): ApimodelsInfo;
};

/**
 * Structural retry hint accepted by {@link RetryableProviderError}'s
 * constructor: the fields the runner's `classifyError` reads, matched
 * field-for-field (no cross-plugin type import).
 *
 * @example
 * ```ts
 * const hint: RetryHint = { status: 503, kind: "resubmit" };
 * ```
 */
export type RetryHint = {
  /** HTTP status code, when the failure came from an HTTP response (5xx or 429). */
  status?: number | undefined;
  /**
   * `"timeout"` / `"network"` for a transport failure. `"resubmit"` when the job
   * must be submitted again (a stale asset id, a task apimodels lost, a dead
   * result URL): the runner retries it like its status says, without counting
   * it against the lane breaker.
   */
  kind?: "timeout" | "network" | "resubmit" | undefined;
  /** Provider-supplied Retry-After delay, ms. */
  retryAfterMs?: number | undefined;
};

/**
 * Retryable transport or provider failure: HTTP 5xx, HTTP 429 (with an
 * optional `Retry-After` hint), a request timeout, a network failure, a
 * task apimodels failed with a retryable code, or a job that must be
 * submitted again (`kind: "resubmit"`). Carries the structural fields the
 * runner's `classifyError` reads (`status`/`kind`/`retryAfterMs`).
 *
 * @example
 * ```ts
 * throw new RetryableProviderError("[ai] apimodels returned HTTP 503.\n  The runner retries it.", { status: 503 });
 * ```
 */
export class RetryableProviderError extends Error {
  /** HTTP status code, when the failure came from an HTTP response (5xx or 429). */
  readonly status: number | undefined;
  /** `"timeout"` / `"network"` for a transport failure; `"resubmit"` for a job to submit again. */
  readonly kind: "timeout" | "network" | "resubmit" | undefined;
  /** Provider-supplied Retry-After delay, ms. */
  readonly retryAfterMs: number | undefined;

  /**
   * Creates a retryable provider error.
   *
   * @param message - Human-readable message (never the key or the prompt).
   * @param hint - The structural classification hint.
   * @example
   * ```ts
   * new RetryableProviderError("[ai] apimodels rate-limited the request (HTTP 429).\n  The runner retries after Retry-After.", { status: 429, retryAfterMs: 2000 });
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
 * What apimodels said about a rejected call, kept on a
 * {@link TerminalProviderError}: its `failCode` and its (redacted, shortened)
 * text. Lets `submit` tell a stale `asset://` id from another bad request.
 *
 * @example
 * ```ts
 * const upstream: UpstreamFailure = { failCode: "INVALID_INPUT", detail: "asset not found" };
 * ```
 */
export type UpstreamFailure = {
  /** apimodels `failCode`, when it named one. */
  failCode?: string | undefined;
  /** apimodels' own text, redacted and shortened. */
  detail?: string | undefined;
};

/**
 * Deterministic failure (a 4xx other than 429, or a task apimodels failed
 * with a non-retryable code): never retried. Carries the `status` field the
 * runner's `classifyError` reads to bucket it as `"http-4xx"`.
 *
 * @example
 * ```ts
 * throw new TerminalProviderError("[ai] apimodels rejected the request (HTTP 400).\n  Check the request fields.", 400);
 * ```
 */
export class TerminalProviderError extends Error {
  /** The HTTP status code that caused the failure. */
  readonly status: number;
  /** apimodels `failCode`, when it named one. */
  readonly failCode: string | undefined;
  /** apimodels' own text, redacted and shortened. */
  readonly detail: string | undefined;

  /**
   * Creates a terminal provider error.
   *
   * @param message - Human-readable message (never the key or the prompt).
   * @param status - The HTTP status code that caused the failure.
   * @param upstream - What apimodels said, when it said anything.
   * @example
   * ```ts
   * new TerminalProviderError("[ai] apimodels rejected the request (HTTP 400).\n  Check the request fields.", 400, { failCode: "INVALID_INPUT" });
   * ```
   */
  constructor(message: string, status: number, upstream: UpstreamFailure = {}) {
    super(message);
    this.name = "TerminalProviderError";
    this.status = status;
    this.failCode = upstream.failCode;
    this.detail = upstream.detail;
  }
}

/**
 * Content-policy rejection: terminal `flagged` state, never re-queued.
 * Carries `kind: "content-policy"`, the field the runner's `classifyError`
 * reads to bucket it as `"content-policy"`.
 *
 * @example
 * ```ts
 * throw new FlaggedProviderError("[ai] apimodels flagged the asset (HTTP 422).\n  Use another image.");
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
   * new FlaggedProviderError("[ai] apimodels flagged the request (content moderation).\n  Change the prompt or the inputs.");
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
 * const error: ApimodelsProviderError = new TerminalProviderError("[ai] apimodels rejected the request (HTTP 400).\n  Check the request fields.", 400);
 * ```
 */
export type ApimodelsProviderError =
  | RetryableProviderError
  | TerminalProviderError
  | FlaggedProviderError;

/**
 * The part of the core journal this plugin uses: provider records, and
 * whether the journal is open (it is not before `app.start()`).
 */
export type ApimodelsJournal = Pick<
  JournalApi,
  "isOpen" | "findProviderRecord" | "putProviderRecords" | "deleteProviderRecord"
>;

/** The registry's public surface — declared once in `../registry` and re-exported for this plugin's consumers. */
export type { RegistryApi } from "../registry";

/**
 * Domain context shared by `api.ts`, `prices.ts`, `upload.ts`, `assets.ts`
 * and `video/handler.ts`: `PluginCtx` supplies `config`/`state`/`emit`;
 * `require` is narrowed to the registry; `env`, `log` and `journal` are the
 * injected core APIs this plugin reads the key, logs and keeps asset ids through.
 */
export type ApimodelsContext = PluginCtx<Config, State> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
  /** Resolved-environment accessor: reads the key at request time, never stores it. */
  env: EnvApi;
  /** Structured logger: receives ids, statuses and fingerprints only (never prompts or keys). */
  log: LogApi;
  /** Durable provider records (asset and asset-group ids). */
  journal: ApimodelsJournal;
};
