/**
 * Standard tier — owns the dialogue capability contract (estimate + execute:
 * a multi-speaker scene in one request, the mix plus one file per line) + typed
 * one-off facade app.dialogue.*. Emits no events.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { registryPlugin } from "../registry";
import { createDialogueApi } from "./api";
import type { Config } from "./types";

const defaultConfig: Config = { defaultProvider: "elevenlabs" };

/**
 * dialogue — Standard tier plugin. Task contract owner + facade. Depends on registry.
 *
 * @see README.md
 */
export const dialoguePlugin = createPlugin("dialogue", {
  depends: [registryPlugin],
  config: defaultConfig,
  api: createDialogueApi
});
