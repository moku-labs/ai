/**
 * @file asset plugin — type definitions (re-exports the contract, plus the
 * plugin's config, public API, and domain context types).
 */
import type { PluginCtx } from "@moku-labs/core";
import type { RegistryApi, registryPlugin } from "../registry";
import type { AssetRecord, AssetRequest } from "./contract";

export type {
  AssetFile,
  AssetGroupKind,
  AssetHandler,
  AssetJobPoll,
  AssetRecord,
  AssetRequest,
  AssetResult
} from "./contract";

/**
 * asset plugin configuration: the provider used when a request doesn't name
 * one, and the poll cadence of the facade's in-memory submit/poll loop.
 *
 * @example
 * ```ts
 * createApp({ pluginConfigs: { asset: { defaultProvider: "ark", pollIntervalMs: 3000 } } });
 * ```
 */
export type Config = {
  /** Provider used by the facade when the caller names none. Default: "ark". */
  defaultProvider: string;
  /** Facade poll cadence, ms. Default: 3000 (Ark GetAsset guidance: poll 3 s). */
  pollIntervalMs: number;
};

/**
 * Public API surface of the `asset` plugin, exposed as `app.asset`. A typed,
 * one-off facade over the registry's opaque handler transport for the
 * "asset" task. The durable path is an `asset` item in a build file.
 *
 * @example
 * ```ts
 * const image = { path: "refs/mira.png", mimeType: "image/png", hash: "a".repeat(64) };
 * const record = await app.asset.register({ image, url: "https://cdn.example/mira.png" });
 * ```
 */
export type AssetApi = {
  /**
   * One-off registration outside the runner: submits once, then polls every
   * `config.pollIntervalMs` until the job is done or failed, and parses the
   * done `body` into the record. NOT journaled and NOT cached: prefer an
   * `asset` item in a build file, which registers the same bytes once.
   *
   * @param request - The portrait to register.
   * @param opts - Optional provider override and abort signal.
   * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
   * @param opts.signal - Abort signal; cancels the provider calls and the poll wait.
   * @returns The registered asset record.
   * @throws {unknown} A failed poll's `error` as-is (a refusal carries `kind: "content-policy"`), or the signal's reason on abort.
   * @throws {Error} `[ai] No asset provider named "<name>" is registered.\n  Available: <list>.`
   * @example
   * ```ts
   * // Register Mira's portrait once, by hand, before trying a video model on it.
   * const image = { path: "refs/mira.png", mimeType: "image/png", hash: "a".repeat(64) };
   * await app.asset.register({ image, url: "https://cdn.example/mira.png" }, { provider: "ark" });
   * // => { assetId: "asset-2026...", provider: "ark", account: "3f9a0c1b2d4e", groupId: "group-...", registeredAt: 1790000000000 }
   * ```
   */
  register(
    request: AssetRequest,
    opts?: { provider?: string; signal?: AbortSignal }
  ): Promise<AssetRecord>;
  /**
   * Cost estimate without registering — calls the same handler `estimate()`
   * the runner's budget gate uses.
   *
   * @param request - The portrait to estimate.
   * @param opts - Optional provider override.
   * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
   * @returns The estimated cost in USD.
   * @throws {Error} `[ai] No asset provider named "<name>" is registered.\n  Available: <list>.`
   * @example
   * ```ts
   * // Budget check before a build: Ark registers assets for free.
   * const image = { path: "refs/mira.png", mimeType: "image/png", hash: "a".repeat(64) };
   * app.asset.estimate({ image }); // => { usd: 0 }
   * ```
   */
  estimate(request: AssetRequest, opts?: { provider?: string }): { usd: number };
  /**
   * Registered asset providers, in registration order.
   *
   * @returns Registered provider names for the "asset" task.
   * @example
   * ```ts
   * // Show which accounts can register portraits.
   * app.asset.providers(); // => ["ark"]
   * ```
   */
  providers(): string[];
};

/** The registry's public surface — declared once in `../registry` and re-exported for this plugin's consumers. */
export type { RegistryApi } from "../registry";

/**
 * Domain context for the asset API factory. `asset` is a stateless facade
 * over `registry` (no `createState`), so `state` is the empty-object shape;
 * `require` is narrowed to the one dependency this plugin calls.
 */
export type AssetContext = PluginCtx<Config, Record<string, never>> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
};
