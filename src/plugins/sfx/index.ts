/**
 * Standard tier — owns the sfx capability contract (estimate + execute, mp3
 * only) + typed one-off facade app.sfx.*. Emits no events.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { registryPlugin } from "../registry";
import { createSfxApi } from "./api";
import type { Config } from "./types";

const defaultConfig: Config = { defaultProvider: "elevenlabs" };

/**
 * sfx — Standard tier plugin. Task contract owner + facade. Depends on registry.
 *
 * @see README.md
 */
export const sfxPlugin = createPlugin("sfx", {
  depends: [registryPlugin],
  config: defaultConfig,
  api: createSfxApi
});
