/**
 * @file apimodels provider plugin — types (Config/State/API), the instance
 * types of the provider errors (the classes live in `errors.ts`), and the
 * domain context type shared by `api.ts`, `upload.ts`, `assets.ts`,
 * `prices.ts`, `video/handler.ts` and `video/poll.ts`.
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import type { PluginCtx } from "@moku-labs/core";
import type { JournalApi } from "../journal/types";
import type { RegistryApi, registryPlugin } from "../registry";
import type {
  FlaggedProviderError as FlaggedProviderErrorClass,
  RetryableProviderError as RetryableProviderErrorClass,
  TerminalProviderError as TerminalProviderErrorClass
} from "./errors";

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

/** Constructor-signature shapes of the error classes, declared in `./errors`. */
export type { RetryHint, UpstreamFailure } from "./errors";

// Type aliases, not `export type { … } from "./errors"`: the .d.ts bundler turns a type-only
// class re-export back into `declare class`, so `Apimodels.X` would pass tsc as a value that is
// `undefined` at runtime. The classes ship as values in `ApimodelsErrors` from the package root.
/** Instance type of the retryable provider error; the class is `ApimodelsErrors.RetryableProviderError`. */
export type RetryableProviderError = RetryableProviderErrorClass;
/** Instance type of the terminal provider error; the class is `ApimodelsErrors.TerminalProviderError`. */
export type TerminalProviderError = TerminalProviderErrorClass;
/** Instance type of the content-policy provider error; the class is `ApimodelsErrors.FlaggedProviderError`. */
export type FlaggedProviderError = FlaggedProviderErrorClass;

/**
 * Any of this plugin's classified provider errors.
 *
 * @example
 * ```ts
 * const error: ApimodelsProviderError = new ApimodelsErrors.TerminalProviderError("[ai] apimodels rejected the request (HTTP 400).\n  Check the request fields.", 400);
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
 * Domain context shared by `api.ts`, `prices.ts`, `upload.ts`, `assets.ts`,
 * `video/handler.ts` and `video/poll.ts`: `PluginCtx` supplies `config`/`state`/`emit`;
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
