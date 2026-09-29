/**
 * @file ark provider plugin — types (Config/State/API), the provider error
 * types (the classes live in `./errors`), and the domain context type shared
 * by `api.ts`, `client.ts`, the video handler and the asset handler.
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import type { PluginCtx } from "@moku-labs/core";
import type { RegistryApi, registryPlugin } from "../registry";
import type { VideoFile, VideoRequest } from "../video/contract";
import type {
  FlaggedProviderError as FlaggedProviderErrorClass,
  RetryableProviderError as RetryableProviderErrorClass,
  TerminalProviderError as TerminalProviderErrorClass
} from "./errors";

/**
 * Which Ark to talk to: `"intl"` is BytePlus ModelArk, `"cn"` is Volcengine Ark.
 *
 * @example
 * ```ts
 * const region: ArkRegion = "intl";
 * ```
 */
export type ArkRegion = "intl" | "cn";

/**
 * ark plugin configuration: region, the env var names of the three keys,
 * URL overrides, the AIGC asset group, request timeout and prices.
 *
 * @example
 * ```ts
 * createApp({ pluginConfigs: { ark: { region: "cn", groupId: "group-20260929-a1" } } });
 * ```
 */
export type Config = {
  /** "intl" = BytePlus ModelArk (default), "cn" = Volcengine Ark. */
  region: ArkRegion;
  /** Env var of the Ark API key (Bearer, video tasks). Default "ARK_API_KEY". */
  apiKeyEnv: string;
  /** Env var of the access key id (signed asset API). Default "ARK_ACCESS_KEY". */
  accessKeyEnv: string;
  /** Env var of the secret access key. Default "ARK_SECRET_KEY". */
  secretKeyEnv: string;
  /** Override of the region's data-plane base URL (tests, proxies). Default null. */
  baseUrl: string | null;
  /** Override of the region's control-plane URL. Default null. */
  controlUrl: string | null;
  /**
   * AIGC asset group id. null = create one with CreateAssetGroup on the first
   * registration of the process and log its id; set it here afterwards. Default null.
   */
  groupId: string | null;
  /** Group name used by CreateAssetGroup when groupId is null. Default "moku-ai". */
  groupName: string;
  /** Per-request timeout, ms. Default 60000. */
  timeoutMs: number;
  /** USD per 1M output tokens by model id; overrides the catalog. Default {}. */
  priceOverrides: Record<string, number>;
  /** CNY per 1 USD, for cn-region cost in USD. Default 7.1. */
  cnyPerUsd: number;
};

/**
 * ark plugin state: per-process memory only (the AIGC group, the account
 * fingerprint, the assets already seen Active, and the one-time negative
 * prompt warning). Nothing here needs releasing on stop.
 */
export type State = {
  /** Single-flight AIGC group id for this process: config.groupId, or created once. */
  group: Promise<string> | null;
  /** Account fingerprint, computed once from region + access key. */
  account: string | null;
  /** Per-process GetAsset preflight cache: assetId → Active, so one run checks each asset once. */
  activeAssets: Set<string>;
  /** Set after the first `ark:negative:ignored` warning, so it logs once per process. */
  negativeWarned: boolean;
};

/**
 * What `app.ark.info()` returns: provider id, region, which key sets are
 * present, and the region's model ids.
 *
 * @example
 * ```ts
 * const info: ArkInfo = {
 *   provider: "ark", region: "intl", configured: { video: true, assets: false },
 *   models: ["dreamina-seedance-2-0-260128", "dreamina-seedance-2-5-260628"]
 * };
 * ```
 */
export type ArkInfo = {
  /** Always "ark". */
  provider: "ark";
  /** The configured region. */
  region: ArkRegion;
  /** `video`: the API key is set. `assets`: the access key and the secret key are both set. */
  configured: { video: boolean; assets: boolean };
  /** Model ids of the configured region, in catalog order. */
  models: string[];
};

/**
 * Public API surface of the `ark` plugin, exposed as `app.ark`. A thin
 * observability surface: the real capability surface is the two registered
 * handlers (`video/ark`, `asset/ark`), used through `app.video`, `app.asset`
 * and `app.runner`.
 *
 * @example
 * ```ts
 * app.ark.info().region; // => "intl"
 * ```
 */
export type ArkApi = {
  /**
   * What this ark instance can do, without any network call. Key presence is
   * read through `ctx.env.get`, so it never throws.
   *
   * @returns Provider, region, configured key sets and the region's model ids.
   * @example
   * ```ts
   * // Before a Seedance run, check ARK_API_KEY is set and the model exists in this region.
   * const { configured, models } = app.ark.info();
   * // configured.video: true once ARK_API_KEY is set; models.includes("dreamina-seedance-2-0-260128"): true on intl
   * ```
   */
  info(): ArkInfo;
};

/**
 * A request image, end frame or ref at estimate time: a resolved file, or
 * still the build-file reference the runner resolves before submit (the
 * runner estimates the unresolved request).
 *
 * @example
 * ```ts
 * const input: EstimateInput = { $ref: "face-mira" };
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
 *   model: "dreamina-seedance-2-0-260128", prompt: "image 1 walks into the rain", refs: [{ $ref: "face-mira" }]
 * };
 * ```
 */
export type EstimateRequest = Omit<VideoRequest, "image" | "endImage" | "refs"> & {
  /** First frame, resolved or not. */
  image?: EstimateInput;
  /** End frame, resolved or not. */
  endImage?: EstimateInput;
  /** Refs, resolved or not. */
  refs?: EstimateInput[];
};

/** Structural retry hint of {@link RetryableProviderError}, declared in `./errors`. */
export type { RetryHint } from "./errors";

// Type aliases, not `export type { … } from "./errors"`: the .d.ts bundler turns a type-only
// class re-export back into `declare class`, so `Ark.X` would pass tsc as a value that is
// `undefined` at runtime. The classes ship as values in `ArkErrors` from the package root.
/** Instance type of the retryable provider error; the class is `ArkErrors.RetryableProviderError`. */
export type RetryableProviderError = RetryableProviderErrorClass;
/** Instance type of the terminal provider error; the class is `ArkErrors.TerminalProviderError`. */
export type TerminalProviderError = TerminalProviderErrorClass;
/** Instance type of the content-policy provider error; the class is `ArkErrors.FlaggedProviderError`. */
export type FlaggedProviderError = FlaggedProviderErrorClass;

/**
 * Any of this plugin's classified provider errors.
 *
 * @example
 * ```ts
 * const error: ArkProviderError = new ArkErrors.TerminalProviderError("[ai] ark task cgt-1 is cancelled.", 410);
 * ```
 */
export type ArkProviderError =
  | RetryableProviderError
  | TerminalProviderError
  | FlaggedProviderError;

/** The registry's public surface — declared once in `../registry` and re-exported for this plugin's consumers. */
export type { RegistryApi } from "../registry";

/**
 * Domain context shared by `api.ts`, `client.ts`, `account.ts`, the video
 * handler and the asset handler — `PluginCtx` supplies `config`/`state`/`emit`;
 * `require` is narrowed to the registry, and `env`/`log` are the injected
 * core APIs this plugin reads its keys and logs redacted diagnostics through.
 */
export type ArkContext = PluginCtx<Config, State> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
  /** Resolved-environment accessor — reads the keys at request time, never stores them. */
  env: EnvApi;
  /** Structured logger — receives ids, codes and status only (never keys, URLs or prompts). */
  log: LogApi;
};
