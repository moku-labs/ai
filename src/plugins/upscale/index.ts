/**
 * Standard tier — owns the upscale capability contract (execute, or async
 * submit + poll) + typed one-off facade app.upscale.*. Emits no events.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { registryPlugin } from "../registry";
import { createUpscaleApi } from "./api";
import type { Config } from "./types";

const defaultConfig: Config = { defaultProvider: "fal", pollIntervalMs: 5000 };

/**
 * upscale — Standard tier plugin. Task contract owner + facade. Depends on registry.
 *
 * @see README.md
 */
export const upscalePlugin = createPlugin("upscale", {
  depends: [registryPlugin],
  config: defaultConfig,
  api: createUpscaleApi
});
