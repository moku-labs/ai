/**
 * @file ark image model catalog — data module. One row per Seedream model id:
 * region, the smallest image it makes (in pixels), how many reference images
 * it takes, how many images one group request counts (refs included) and the
 * price per image in USD. BytePlus trusts a face in a
 * Seedance request when it comes from Seedream 5.0 lite text-to-image on the
 * same account, with the bytes unchanged.
 */
import type { ArkRegion } from "../types";

/**
 * One Seedream model on Ark.
 */
export type ArkImageModel = {
  /** Ark model id, sent as `model`. */
  id: string;
  /** The region that serves this id. */
  region: ArkRegion;
  /** Smallest `size` the model takes, as width × height pixels. */
  minPixels: number;
  /** Most reference images one request takes, sent as `image`. */
  maxRefImages: number;
  /** Most images one group request counts: refs plus `params.images`. */
  maxGroupImages: number;
  /** Price of one image, USD. */
  priceUsd: number;
};

/**
 * The image catalog, in order. Each row carries its `// source:`.
 *
 * @example
 * ```ts
 * arkImageModels.map(model => model.id); // => ["seedream-5-0-lite-260128"]
 * ```
 */
export const arkImageModels: readonly ArkImageModel[] = [
  // source: https://docs.byteplus.com/en/docs/modelark/model-pricing (checked 2026-09-30)
  // minPixels: live BytePlus intl run 2026-09-30 (400 on 1152x2048, 200 on 1440x2560)
  // maxRefImages: https://docs.byteplus.com/en/docs/ModelArk/1541523 (checked 2026-10-01)
  // source: https://docs.byteplus.com/en/docs/ModelArk/1541523 (checked 2026-10-01), maxGroupImages: refs + images <= 15
  {
    id: "seedream-5-0-lite-260128",
    region: "intl",
    minPixels: 3_686_400,
    maxRefImages: 14,
    maxGroupImages: 15,
    priceUsd: 0.035
  }
];

/**
 * Image model when the request names none.
 *
 * @example
 * ```ts
 * DEFAULT_IMAGE_MODEL; // => "seedream-5-0-lite-260128"
 * ```
 */
export const DEFAULT_IMAGE_MODEL = "seedream-5-0-lite-260128";

/**
 * The image model ids a region serves, in catalog order.
 *
 * @param region - The Ark region.
 * @returns Image model ids; empty on a region without one.
 * @example
 * ```ts
 * imageModelsOf("cn"); // => []
 * ```
 */
export function imageModelsOf(region: ArkRegion): string[] {
  return arkImageModels.filter(model => model.region === region).map(model => model.id);
}

/**
 * Looks up an image model id for the configured region.
 *
 * @param id - `request.model`; the default model when undefined.
 * @param region - The configured region.
 * @returns The catalog row.
 * @throws {Error} `[ai] Unknown ark image model "<id>".` for an id this region does not serve.
 * @example
 * ```ts
 * resolveArkImageModel(undefined, "intl").minPixels; // => 3686400
 * ```
 */
export function resolveArkImageModel(id: string | undefined, region: ArkRegion): ArkImageModel {
  const wanted = id ?? DEFAULT_IMAGE_MODEL;
  const model = arkImageModels.find(row => row.id === wanted && row.region === region);
  if (model !== undefined) return model;

  const known = imageModelsOf(region);
  const list = known.length === 0 ? `none in region ${region}` : known.join(", ");
  throw new Error(`[ai] Unknown ark image model "${wanted}".\n  Known: ${list}.`);
}
