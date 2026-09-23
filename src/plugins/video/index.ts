/**
 * Standard tier — owns the video capability contract (execute, or async
 * submit + poll) + typed one-off facade app.video.*.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { registryPlugin } from "../registry";
import { createVideoApi } from "./api";
import type { Config } from "./types";

const defaultConfig: Config = { defaultProvider: "fal", pollIntervalMs: 5000 };

/**
 * video — Standard tier plugin. Task contract owner + facade. Depends on registry.
 *
 * @see README.md
 */
export const videoPlugin = createPlugin("video", {
  depends: [registryPlugin],
  config: defaultConfig,
  api: createVideoApi
});
