/**
 * Complex tier — ElevenLabs provider: owns all ElevenLabs capabilities
 * (M0: voiceover via thin fetch client). Registers handlers in onInit.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { registryPlugin } from "../registry";
import { createElevenlabsApi } from "./api";
import { createElevenlabsState } from "./state";
import type { Config } from "./types";
import { createVoiceoverHandler } from "./voiceover/handler";

const defaultConfig: Config = {
  apiKeyEnv: "ELEVENLABS_API_KEY",
  baseUrl: "https://api.elevenlabs.io",
  defaultModel: "eleven_multilingual_v2",
  timeoutMs: 60_000,
  priceOverrides: {}
};

/**
 * elevenlabs — Complex tier provider plugin. Depends on registry (onInit registration).
 *
 * @see README.md
 */
export const elevenlabsPlugin = createPlugin("elevenlabs", {
  depends: [registryPlugin],
  config: defaultConfig,
  createState: createElevenlabsState,
  api: createElevenlabsApi,
  /**
   * Registers the ElevenLabs voiceover handler with the registry.
   *
   * @param ctx - Plugin context (registry access via ctx.require).
   * @example
   * ```ts
   * app.voiceover.providers(); // ["elevenlabs", ...]
   * ```
   */
  onInit: ctx => {
    ctx.require(registryPlugin).register("voiceover", "elevenlabs", createVoiceoverHandler(ctx));
  }
});
