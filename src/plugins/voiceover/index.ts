/**
 * Standard tier — owns the voiceover capability contract + typed one-off
 * facade app.voiceover.* + M0 template packs.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { registryPlugin } from "../registry";
import { createVoiceoverApi } from "./api";
import type { Config } from "./types";

const defaultConfig: Config = { defaultProvider: "elevenlabs", defaultFormat: "mp3" };

/**
 * voiceover — Standard tier plugin. Task contract owner + facade. Depends on registry.
 *
 * @see README.md
 */
export const voiceoverPlugin = createPlugin("voiceover", {
  depends: [registryPlugin],
  config: defaultConfig,
  api: createVoiceoverApi
});
