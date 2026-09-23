/**
 * Standard tier — owns the image capability contract + typed one-off
 * facade app.image.*. No packs, no state, no events.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { registryPlugin } from "../registry";
import { createImageApi } from "./api";
import type { Config } from "./types";

const defaultConfig: Config = { defaultProvider: "codex" };

/**
 * image — Standard tier plugin. Still-image task contract owner + facade. Depends on registry.
 *
 * @see README.md
 */
export const imagePlugin = createPlugin("image", {
  depends: [registryPlugin],
  config: defaultConfig,
  api: createImageApi
});
