/**
 * Complex tier — ark provider: Seedance and Seedream straight from ByteDance,
 * on BytePlus ModelArk (`region: "intl"`) or Volcengine Ark (`region: "cn"`).
 * Registers three handlers in onInit: `video/ark` (Seedance video tasks, with
 * an asset preflight before any paid call, and draft → final), `asset/ark`
 * (portrait registration into an AIGC group through the signed asset OpenAPI)
 * and `image/ark` (Seedream text- and image-to-image, bytes unchanged). Emits no events.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { registryPlugin } from "../registry";
import { createArkApi } from "./api";
import { createAssetHandler } from "./asset/handler";
import { createImageHandler } from "./image/handler";
import { createArkState } from "./state";
import type { Config } from "./types";
import { createVideoHandler } from "./video/handler";

const defaultConfig: Config = {
  region: "intl",
  apiKeyEnv: "ARK_API_KEY",
  accessKeyEnv: "ARK_ACCESS_KEY",
  secretKeyEnv: "ARK_SECRET_KEY",
  // eslint-disable-next-line unicorn/no-null -- Config.baseUrl is `string | null`: null = the region's URL
  baseUrl: null,
  // eslint-disable-next-line unicorn/no-null -- Config.controlUrl is `string | null`: null = the region's URL
  controlUrl: null,
  // eslint-disable-next-line unicorn/no-null -- Config.groupId is `string | null`: null = create one per process
  groupId: null,
  groupName: "moku-ai",
  timeoutMs: 60_000,
  downloadTimeoutMs: 300_000,
  priceOverrides: {},
  cnyPerUsd: 7.1
};

/**
 * ark — Complex tier provider plugin. One instance is one account. Registers
 * `("video", "ark")`, `("asset", "ark")` and `("image", "ark")` in onInit.
 * Depends on registry only; the task contracts are module imports, not plugin
 * edges. Keys are read through `ctx.env`, logs go through `ctx.log`, draft
 * task ids are kept through `ctx.journal`.
 *
 * @see README.md
 */
export const arkPlugin = createPlugin("ark", {
  depends: [registryPlugin],
  config: defaultConfig,
  createState: createArkState,
  api: createArkApi,
  /**
   * Registers the ark video, asset and image handlers with the registry.
   *
   * @param ctx - Plugin context (registry access via ctx.require).
   */
  onInit: ctx => {
    const registry = ctx.require(registryPlugin);
    registry.register("video", "ark", createVideoHandler(ctx));
    registry.register("asset", "ark", createAssetHandler(ctx));
    registry.register("image", "ark", createImageHandler(ctx));
  }
});
