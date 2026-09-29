/**
 * Complex tier — fal provider: every fal-hosted task over one client, one key,
 * one upload cache and one price table. Registers `video`, `image`,
 * `prompt-gen` and `music` handlers in onInit. Emits no events.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { registryPlugin } from "../registry";
import { createFalApi } from "./api";
import { createImageHandler } from "./image/handler";
import { createPromptGenHandler } from "./llm/handler";
import { createMusicHandler } from "./music/handler";
import { createFalState } from "./state";
import type { Config } from "./types";
import { createVideoHandler } from "./video/handler";

const defaultConfig: Config = {
  apiKeyEnv: "FAL_KEY",
  queueUrl: "https://queue.fal.run",
  uploadUrl: "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3",
  upload: "storage",
  timeoutMs: 60_000,
  priceOverrides: {},
  runUrl: "https://fal.run",
  imageDefaultModel: "gpt-image-2.5",
  llmDefaultModel: "anthropic/claude-opus-5.5",
  pollIntervalMs: 2000,
  jobTimeoutMs: 900_000,
  requestLog: ""
};

/**
 * fal — Complex tier provider plugin. Registers the four fal-hosted tasks in
 * onInit over one client, key, upload cache and price table. Depends on
 * registry only; the task contracts are module imports. The upload cache
 * lives for the process.
 *
 * @see README.md
 */
export const falPlugin = createPlugin("fal", {
  depends: [registryPlugin],
  config: defaultConfig,
  createState: createFalState,
  api: createFalApi,
  /**
   * Registers the fal handlers (video, image, prompt-gen, music) with the registry.
   *
   * @param ctx - Plugin context (registry access via ctx.require).
   * @returns {void} Nothing; the four handlers are registered.
   */
  onInit: ctx => {
    const registry = ctx.require(registryPlugin);
    registry.register("video", "fal", createVideoHandler(ctx));
    registry.register("image", "fal", createImageHandler(ctx));
    registry.register("prompt-gen", "fal", createPromptGenHandler(ctx));
    registry.register("music", "fal", createMusicHandler(ctx));
  }
});
