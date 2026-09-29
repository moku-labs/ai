/**
 * @file ark model catalog — data module. One row per Seedance model id:
 * region, clip length limits, resolutions, reference limits, seed and audio
 * support, and the price per 1M output tokens in the region's currency.
 * Adding a model is one object in {@link arkModels}. Ids and prices come from
 * summaries of the official rate cards: verify them in the console.
 */
import type { ArkRegion, EstimateRequest } from "./types";

/**
 * One Seedance model on Ark.
 *
 * @example
 * ```ts
 * const row: ArkVideoModel = {
 *   id: "dreamina-seedance-2-0-260128", region: "intl", minSeconds: 4, maxSeconds: 15,
 *   resolutions: ["480p", "720p", "1080p"], maxRefImages: 9, maxRefVideos: 3, maxRefAudios: 3,
 *   supportsSeed: false, supportsAudio: true, price: { base: 7, withVideoInput: 4.3 }
 * };
 * ```
 */
export type ArkVideoModel = {
  /** Ark model id, sent as `model`. */
  id: string;
  /** The region that serves this id. */
  region: ArkRegion;
  /** Shortest clip, seconds. */
  minSeconds: number;
  /** Longest clip of one generation, seconds. */
  maxSeconds: number;
  /** Accepted `resolution` values. */
  resolutions: readonly string[];
  /** Most reference images (local images and asset refs) in one request. */
  maxRefImages: number;
  /** Most reference videos (`params.refUrls`) in one request. */
  maxRefVideos: number;
  /** Most reference audios (`params.refUrls`) in one request. */
  maxRefAudios: number;
  /** Whether the model takes `seed`. */
  supportsSeed: boolean;
  /** Whether the model can generate audio (`generate_audio`). */
  supportsAudio: boolean;
  /** Price per 1M output tokens in the region currency; `withVideoInput` when a video ref is sent. */
  price: { base: number; withVideoInput: number };
};

/** Clip length when the request names none, seconds. */
export const DEFAULT_SECONDS = 5;

/** Resolution when the request names none. Every catalog row takes it. */
export const DEFAULT_RESOLUTION = "720p";

/**
 * The catalog, in order. Each row carries its `// source:`.
 *
 * @example
 * ```ts
 * arkModels.map(model => model.id).includes("doubao-seedance-2-0-260128"); // => true
 * ```
 */
export const arkModels: readonly ArkVideoModel[] = [
  // source: https://docs.byteplus.com/en/docs/ModelArk (Seedance 2.0 rate card, via a third-party summary; verify in console)
  {
    id: "dreamina-seedance-2-0-260128",
    region: "intl",
    minSeconds: 4,
    maxSeconds: 15,
    resolutions: ["480p", "720p", "1080p"],
    maxRefImages: 9,
    maxRefVideos: 3,
    maxRefAudios: 3,
    supportsSeed: false,
    supportsAudio: true,
    price: { base: 7, withVideoInput: 4.3 }
  },
  // source: https://www.volcengine.com/docs/82379 (Seedance 2.0 rate card, via a third-party summary; verify in console)
  {
    id: "doubao-seedance-2-0-260128",
    region: "cn",
    minSeconds: 4,
    maxSeconds: 15,
    resolutions: ["480p", "720p", "1080p"],
    maxRefImages: 9,
    maxRefVideos: 3,
    maxRefAudios: 3,
    supportsSeed: false,
    supportsAudio: true,
    price: { base: 46, withVideoInput: 28 }
  },
  // source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/docs/models.md + https://cellcog.ai/blog/seedance-2-5-pricing/ (verify in console)
  {
    id: "dreamina-seedance-2-5-260628",
    region: "intl",
    minSeconds: 4,
    maxSeconds: 30,
    resolutions: ["480p", "720p"],
    maxRefImages: 30,
    maxRefVideos: 10,
    maxRefAudios: 10,
    supportsSeed: false,
    supportsAudio: true,
    price: { base: 10.7, withVideoInput: 6.4 }
  },
  // source: https://www.aitop100.cn/infomation/details/34378.html + reseller docs (id unverified; verify in console)
  {
    id: "doubao-seedance-2-5-260628",
    region: "cn",
    minSeconds: 4,
    maxSeconds: 30,
    resolutions: ["480p", "720p"],
    maxRefImages: 30,
    maxRefVideos: 10,
    maxRefAudios: 10,
    supportsSeed: false,
    supportsAudio: true,
    price: { base: 70, withVideoInput: 42 }
  }
];

/**
 * The model ids a region serves, in catalog order.
 *
 * @param region - The Ark region.
 * @returns Model ids.
 * @example
 * ```ts
 * modelsOf("cn"); // => ["doubao-seedance-2-0-260128", "doubao-seedance-2-5-260628"]
 * ```
 */
export function modelsOf(region: ArkRegion): string[] {
  return arkModels.filter(model => model.region === region).map(model => model.id);
}

/**
 * Looks up a model id for the configured region.
 *
 * @param id - The requested model id (`request.model`).
 * @param region - The configured region.
 * @returns The catalog row.
 * @throws {Error} `[ai] Unknown ark model "<id>".` for an id not in the catalog.
 * @throws {Error} `[ai] Model <id> is a <region> model.` for an id of the other region.
 * @example
 * ```ts
 * resolveArkModel("doubao-seedance-2-0-260128", "cn").maxSeconds; // => 15
 * ```
 */
export function resolveArkModel(id: string, region: ArkRegion): ArkVideoModel {
  const model = arkModels.find(row => row.id === id);
  if (model === undefined) {
    const known = arkModels.map(row => row.id).join(", ");
    throw new Error(`[ai] Unknown ark model "${id}".\n  Known: ${known}.`);
  }
  if (model.region !== region) {
    throw new Error(
      `[ai] Model ${id} is a ${model.region} model.\n  Set ark region to "${model.region}" or pick a ${region} model.`
    );
  }
  return model;
}

/**
 * The clip length of a request, checked against the model's limits.
 *
 * @param model - The catalog row.
 * @param seconds - `request.seconds`; 5 when undefined.
 * @returns Seconds.
 * @throws {Error} A plain two-line error naming the model's limits.
 * @example
 * ```ts
 * checkSeconds(resolveArkModel("dreamina-seedance-2-0-260128", "intl"), undefined); // => 5
 * ```
 */
export function checkSeconds(model: ArkVideoModel, seconds: number | undefined): number {
  const value = seconds ?? DEFAULT_SECONDS;
  const isInRange = value >= model.minSeconds && value <= model.maxSeconds;
  if (!isInRange) {
    throw new Error(
      `[ai] Model ${model.id} takes ${model.minSeconds} to ${model.maxSeconds} seconds.\n  Got ${value}; set input.seconds in that range.`
    );
  }
  return value;
}

/**
 * The resolution of a request, checked against the model's list.
 *
 * @param model - The catalog row.
 * @param resolution - `request.resolution`; 720p when undefined.
 * @returns The resolution.
 * @throws {Error} A plain two-line error listing the model's resolutions.
 * @example
 * ```ts
 * checkResolution(resolveArkModel("dreamina-seedance-2-0-260128", "intl"), "1080p"); // => "1080p"
 * ```
 */
export function checkResolution(model: ArkVideoModel, resolution: string | undefined): string {
  const value = resolution ?? DEFAULT_RESOLUTION;
  if (!model.resolutions.includes(value)) {
    throw new Error(
      `[ai] Model ${model.id} does not take resolution "${value}".\n  Use one of: ${model.resolutions.join(", ")}.`
    );
  }
  return value;
}

/**
 * Checks the parts of a request the estimate can check before the runner
 * resolves its files: seconds and resolution.
 *
 * @param model - The catalog row.
 * @param request - The request, files resolved or not.
 * @returns The checked seconds and resolution.
 * @throws {Error} The {@link checkSeconds} or {@link checkResolution} error.
 * @example
 * ```ts
 * checkClip(resolveArkModel("dreamina-seedance-2-0-260128", "intl"), { model: "dreamina-seedance-2-0-260128", prompt: "p" });
 * // => { seconds: 5, resolution: "720p" }
 * ```
 */
export function checkClip(
  model: ArkVideoModel,
  request: Pick<EstimateRequest, "seconds" | "resolution">
): { seconds: number; resolution: string } {
  return {
    seconds: checkSeconds(model, request.seconds),
    resolution: checkResolution(model, request.resolution)
  };
}
