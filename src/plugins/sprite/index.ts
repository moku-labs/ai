/**
 * Standard tier — owns the sprite capability contract (estimate + execute (no submit/poll)) + typed
 * one-off facade app.sprite.* + the pure pixel step `processSprite`. Emits no events.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { registryPlugin } from "../registry";
import { createSpriteApi } from "./api";
import type { Config } from "./types";

const defaultConfig: Config = { defaultProvider: "fal" };

/**
 * sprite — Standard tier plugin. Task contract owner + facade. Depends on registry.
 *
 * @see README.md
 */
export const spritePlugin = createPlugin("sprite", {
  depends: [registryPlugin],
  config: defaultConfig,
  api: createSpriteApi
});
