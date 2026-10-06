/**
 * @file ark provider plugin — types (Config/State/API), the provider error
 * types (the classes live in `./errors`), and the domain context type shared
 * by `api.ts`, `client.ts`, the video handler and the asset handler.
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
 * URL overrides, the AIGC asset group, request and download timeouts, and prices.
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
  /** Timeout of one clip or image download, ms. Default 300000: a 1080p or 30 s clip is large. */
  downloadTimeoutMs: number;
  /**
   * Overrides the catalog price, by model id: USD per 1M output tokens for a
   * video model, USD per image for an image model. Default {}.
   */
  priceOverrides: Record<string, number>;
  /** CNY per 1 USD, for cn-region cost in USD. Default 7.1. */
  cnyPerUsd: number;
};

/**
 * ark plugin state: per-process memory only (the AIGC group, the account
 * fingerprint, the assets already seen Active, and the one-time warnings).
 * Nothing here needs releasing on stop.
 */
export type State = {
  /** Single-flight AIGC group ids by name; failed lookups are forgotten. */
  group: Map<string, Promise<string>>;
  /** Account fingerprint, computed once from region + access key. */
  account: string | null;
  /** Per-process GetAsset preflight cache: assetId → Active, so one run checks each asset once. */
  activeAssets: Set<string>;
  /** Set after the first `ark:negative:ignored` warning of a video, so it logs once per process. */
  negativeWarned: boolean;
  /** Set after the first `ark:negative:ignored` warning of an image, so it logs once per process. */
  imageNegativeWarned: boolean;
  /** Set after the first `ark:ratio:ignored` warning, so it logs once per process. */
  ratioWarned: boolean;
  /** Set after the first `ark:journal:closed` warning, so it logs once per process. */
  journalSkipLogged: boolean;
};

/**
 * What `app.ark.info()` returns: provider id, region, which key sets are
 * present, and the region's video and image model ids.
 *
 * @example
 * ```ts
 * const info: ArkInfo = {
 *   provider: "ark", region: "intl", configured: { video: true, assets: false, image: true },
 *   models: ["dreamina-seedance-2-0-260128", "dreamina-seedance-2-5-260628"],
 *   imageModels: ["seedream-5-0-lite-260128"]
 * };
 * ```
 */
export type ArkInfo = {
  /** Always "ark". */
  provider: "ark";
  /** The configured region. */
  region: ArkRegion;
  /**
   * `video` and `image`: the API key is set. `assets`: the access key and the
   * secret key are both set.
   */
  configured: { video: boolean; assets: boolean; image: boolean };
  /** Video model ids of the configured region, in catalog order. */
  models: string[];
  /** Image model ids of the configured region, in catalog order. */
  imageModels: string[];
};

/**
 * Public API surface of the `ark` plugin, exposed as `app.ark`. A thin
 * observability surface: the real capability surface is the three registered
 * handlers (`video/ark`, `asset/ark`, `image/ark`), used through `app.video`,
 * `app.asset`, `app.image` and `app.runner`.
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
   * @returns Provider, region, configured key sets and the region's video and image model ids.
   * @example
   * ```ts
   * // Before a Seedance run, check ARK_API_KEY is set and the models exist in this region.
   * const { configured, models, imageModels } = app.ark.info();
   * // configured.video: true once ARK_API_KEY is set; models.includes("dreamina-seedance-2-0-mini-260615"): true on intl
   * // imageModels: ["seedream-5-0-lite-260128"] on intl, [] on cn
   * ```
   */
  info(): ArkInfo;
  /**
   * Lists every AIGC asset group, following all numbered pages.
   *
   * @param opts - Optional cancellation signal.
   * @param opts.signal - Aborts the OpenAPI calls.
   * @returns The groups in Ark's page order.
   * @example
   * ```ts
   * const groups = await app.ark.listAssetGroups();
   * const portraits = groups.filter(group => group.name === "portraits");
   * ```
   */
  listAssetGroups(opts?: { signal?: AbortSignal }): Promise<ArkAssetGroup[]>;
  /**
   * Lists every AIGC asset, optionally restricted to one group.
   *
   * @param filter - Optional group filter.
   * @param filter.groupId - Restricts the list to this group.
   * @param opts - Optional cancellation signal.
   * @param opts.signal - Aborts the OpenAPI calls.
   * @returns The assets in Ark's page order.
   * @example
   * ```ts
   * const assets = await app.ark.listAssets({ groupId: "group-1" });
   * const active = assets.filter(asset => asset.status === "Active");
   * ```
   */
  listAssets(filter?: { groupId?: string }, opts?: { signal?: AbortSignal }): Promise<ArkAsset[]>;
  /**
   * Deletes an asset and forgets its cached Active status after success.
   *
   * @param assetId - The asset to delete.
   * @param opts - Optional cancellation signal.
   * @param opts.signal - Aborts the OpenAPI call.
   * @returns Resolves after deletion and cache cleanup.
   * @example
   * ```ts
   * await app.ark.deleteAsset("asset-1");
   * ```
   */
  deleteAsset(assetId: string, opts?: { signal?: AbortSignal }): Promise<void>;
  /**
   * Deletes a group and its assets, then forgets matching cached names and Active statuses.
   *
   * @param groupId - The group to delete.
   * @param opts - Optional cancellation signal.
   * @param opts.signal - Aborts the OpenAPI call.
   * @returns Resolves after deletion and cache cleanup.
   * @example
   * ```ts
   * await app.ark.deleteAssetGroup("group-1");
   * ```
   */
  deleteAssetGroup(groupId: string, opts?: { signal?: AbortSignal }): Promise<void>;
};

/**
 * One listed Ark asset, with provider time strings preserved as returned.
 *
 * @example
 * ```ts
 * const asset: ArkAsset = { assetId: "asset-1", name: "mira", groupId: "group-1", status: "Active" };
 * ```
 */
export type ArkAsset = {
  /** Ark's asset id. */
  assetId: string;
  /** Display name, or an empty string when absent. */
  name: string;
  /** Containing group id, or an empty string when absent. */
  groupId: string;
  /** Ark's status, or "unknown" when absent. */
  status: string;
  /** Creation time, absent when Ark omits it. */
  createTime?: string;
  /** Update time, absent when Ark omits it. */
  updateTime?: string;
  /** Last inference time, absent when Ark omits it. */
  lastInferenceTime?: string;
};

/**
 * One listed AIGC asset group, with its optional provider creation time.
 *
 * @example
 * ```ts
 * const group: ArkAssetGroup = { groupId: "group-1", name: "portraits" };
 * ```
 */
export type ArkAssetGroup = {
  /** Ark's group id. */
  groupId: string;
  /** Display name, or an empty string when absent. */
  name: string;
  /** Creation time, absent when Ark omits it. */
  createTime?: string;
};

/** Estimate-time request types — declared once in `../video/contract` and re-exported for this plugin's consumers. */
export type { EstimateInput, EstimateRequest } from "../video/contract";

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
 * The part of the core journal this plugin uses: provider records (the
 * draft task of a draft clip), and whether the journal is open (it is not
 * before `app.start()`).
 */
export type ArkJournal = Pick<JournalApi, "isOpen" | "findProviderRecord" | "putProviderRecords">;

/**
 * Domain context shared by `api.ts`, `client.ts`, `account.ts` and the video,
 * image and asset handlers — `PluginCtx` supplies `config`/`state`/`emit`;
 * `require` is narrowed to the registry, and `env`/`log`/`journal` are the
 * injected core APIs this plugin reads its keys, logs redacted diagnostics
 * and keeps draft task ids through.
 */
export type ArkContext = PluginCtx<Config, State> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
  /** Resolved-environment accessor — reads the keys at request time, never stores them. */
  env: EnvApi;
  /** Structured logger — receives ids, codes and status only (never keys, URLs or prompts). */
  log: LogApi;
  /** Durable provider records: the draft task id of each draft clip. */
  journal: ArkJournal;
};
