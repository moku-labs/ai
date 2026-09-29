/**
 * Standard tier — owns the music capability contract (execute, or async
 * submit + poll) + typed one-off facade app.music.*. Emits no events.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { registryPlugin } from "../registry";
import { createMusicApi } from "./api";
import type { Config } from "./types";

const defaultConfig: Config = { defaultProvider: "fal", pollIntervalMs: 5000 };

/**
 * music — Standard tier plugin. Task contract owner + facade. Depends on registry.
 *
 * @see README.md
 */
export const musicPlugin = createPlugin("music", {
  depends: [registryPlugin],
  config: defaultConfig,
  api: createMusicApi
});
