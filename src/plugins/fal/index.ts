/**
 * Complex tier — fal provider: video over the fal queue REST API (submit,
 * status, result). Registers the async `video` handler in onInit.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { registryPlugin } from "../registry";
import { createFalApi } from "./api";
import { createFalState } from "./state";
import type { Config } from "./types";
import { createVideoHandler } from "./video/handler";

const defaultConfig: Config = {
  apiKeyEnv: "FAL_KEY",
  queueUrl: "https://queue.fal.run",
  uploadUrl: "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3",
  upload: "storage",
  timeoutMs: 60_000,
  priceOverrides: {}
};

/**
 * fal — Complex tier provider plugin. Registers `("video", "fal")` in onInit.
 * Depends on registry only, like the elevenlabs/openai providers; the `video`
 * contract is a type-only import. The upload cache lives for the process.
 *
 * @see README.md
 */
export const falPlugin = createPlugin("fal", {
  depends: [registryPlugin],
  config: defaultConfig,
  createState: createFalState,
  api: createFalApi,
  /**
   * Registers the fal video handler with the registry.
   *
   * @param ctx - Plugin context (registry access via ctx.require).
   * @example
   * ```ts
   * app.video.providers(); // ["fal", ...]
   * ```
   */
  onInit: ctx => {
    ctx.require(registryPlugin).register("video", "fal", createVideoHandler(ctx));
  }
});
