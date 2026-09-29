/**
 * @file ark region table — data module. One row per region: the data plane
 * (video tasks, Bearer API key), the control plane (asset OpenAPI, signed
 * with AK/SK), the signature's region and service, and the currency of the
 * region's catalog prices.
 */
import type { ArkRegion, Config } from "./types";

/**
 * Endpoints and signing scope of one Ark region.
 *
 * @example
 * ```ts
 * const cn: ArkRegionInfo = {
 *   dataPlane: "https://ark.cn-beijing.volces.com/api/v3", controlPlane: "https://open.volcengineapi.com",
 *   signRegion: "cn-beijing", signService: "ark", currency: "CNY"
 * };
 * ```
 */
export type ArkRegionInfo = {
  /** Data-plane base URL: video tasks, Bearer API key. */
  dataPlane: string;
  /** Control-plane URL: asset OpenAPI, signed with the access key and secret key. */
  controlPlane: string;
  /** Region in the signature's credential scope. */
  signRegion: string;
  /** Service in the signature's credential scope. */
  signService: string;
  /** Currency of the region's catalog prices. */
  currency: "USD" | "CNY";
};

/**
 * The two Ark regions. `intl` is BytePlus ModelArk, `cn` is Volcengine Ark.
 *
 * @example
 * ```ts
 * arkRegions.intl.signRegion; // => "ap-southeast-1"
 * ```
 */
export const arkRegions: Readonly<Record<ArkRegion, ArkRegionInfo>> = {
  intl: {
    dataPlane: "https://ark.ap-southeast.bytepluses.com/api/v3",
    controlPlane: "https://ark.ap-southeast-1.byteplusapi.com",
    signRegion: "ap-southeast-1",
    signService: "ark",
    currency: "USD"
  },
  cn: {
    dataPlane: "https://ark.cn-beijing.volces.com/api/v3",
    controlPlane: "https://open.volcengineapi.com",
    signRegion: "cn-beijing",
    signService: "ark",
    currency: "CNY"
  }
};

/** Version of the Ark asset OpenAPI every control-plane call names. */
export const OPENAPI_VERSION = "2024-01-01";

/**
 * Drops trailing slashes, so a base URL joins with a path cleanly.
 *
 * @param url - A base URL.
 * @returns The URL without trailing slashes.
 * @example
 * ```ts
 * withoutTrailingSlash("https://proxy.example/v3/"); // => "https://proxy.example/v3"
 * ```
 */
function withoutTrailingSlash(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end -= 1;
  return url.slice(0, end);
}

/**
 * The data-plane base URL: `config.baseUrl`, else the region's.
 *
 * @param config - The region and the override.
 * @returns The base URL, without a trailing slash.
 * @example
 * ```ts
 * dataPlaneUrl({ region: "cn", baseUrl: null }); // => "https://ark.cn-beijing.volces.com/api/v3"
 * ```
 */
export function dataPlaneUrl(config: Pick<Config, "region" | "baseUrl">): string {
  return withoutTrailingSlash(config.baseUrl ?? arkRegions[config.region].dataPlane);
}

/**
 * The control-plane URL: `config.controlUrl`, else the region's.
 *
 * @param config - The region and the override.
 * @returns The URL, without a trailing slash.
 * @example
 * ```ts
 * controlPlaneUrl({ region: "intl", controlUrl: null }); // => "https://ark.ap-southeast-1.byteplusapi.com"
 * ```
 */
export function controlPlaneUrl(config: Pick<Config, "region" | "controlUrl">): string {
  return withoutTrailingSlash(config.controlUrl ?? arkRegions[config.region].controlPlane);
}
