/**
 * Complex tier — apimodels provider: Seedance 2.5 and Seedance 2.0 official
 * video over the apimodels.app task API, with optional `asset://`
 * registration of the inputs a request names (real faces). Registers the
 * async `video` handler in onInit. Emits no events.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { registryPlugin } from "../registry";
import { createApimodelsApi } from "./api";
import { createApimodelsState } from "./state";
import type { Config } from "./types";
import { createVideoHandler } from "./video/handler";

const defaultConfig: Config = {
  apiKeyEnv: "APIMODELS_API_KEY",
  baseUrl: "https://api.apimodels.app/v1",
  assetGroup: "moku-ai",
  timeoutMs: 60_000,
  priceOverrides: {}
};

/**
 * apimodels — Complex tier provider plugin. Registers `("video", "apimodels")`
 * in onInit. Seedance 2.5 / 2.0 official, with optional `asset://`
 * registration for real faces. Depends on registry only; reads the core
 * `ctx.journal` (asset ids), `ctx.env` (key) and `ctx.log`.
 *
 * @see README.md
 */
export const apimodelsPlugin = createPlugin("apimodels", {
  depends: [registryPlugin],
  config: defaultConfig,
  createState: createApimodelsState,
  api: createApimodelsApi,
  /**
   * Registers the apimodels video handler with the registry.
   *
   * @param ctx - Plugin context (registry access via ctx.require).
   */
  onInit: ctx => {
    ctx.require(registryPlugin).register("video", "apimodels", createVideoHandler(ctx));
  }
});
