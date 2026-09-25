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
 * contract is a type-only import. `app.stop()` clears the upload cache.
 *
 * @see README.md
 */
// @no-resource-check — onStop clears the per-process cache of fal storage URLs (state.uploads) (spec/03)
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
  },
  /**
   * Forgets the fal storage URLs of this process.
   *
   * @param ctx - Teardown context; only the fal state is used.
   * @param ctx.state - fal state.
   * @example
   * ```ts
   * await app.stop(); // the next submit uploads its files again
   * ```
   */
  onStop: ({ state }) => {
    state.uploads.clear();
  }
});
