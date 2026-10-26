/**
 * Complex tier — OpenAI provider via the official SDK: voiceover (tts) +
 * translate (Chat Completions) + prompt-gen (Responses API) submodules.
 * Registers all three in onInit.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { registryPlugin } from "../registry";
import { createOpenaiApi } from "./api";
import { createPromptGenHandler } from "./prompt-gen/handler";
import { createOpenaiState } from "./state";
import { createTranslateHandler } from "./translate/handler";
import { createTtsHandler } from "./tts/handler";
import type { Config } from "./types";

const defaultConfig: Config = {
  apiKeyEnv: "OPENAI_API_KEY",
  models: { tts: "gpt-4o-mini-tts", chat: "gpt-4o-mini" },
  timeoutMs: 60_000,
  promptGenTimeoutMs: 900_000,
  priceOverrides: {}
};

/**
 * openai — Complex tier provider plugin. Depends on registry (onInit registration ×3).
 * Complex tier. Emits no events.
 *
 * @see README.md
 */
export const openaiPlugin = createPlugin("openai", {
  depends: [registryPlugin],
  config: defaultConfig,
  createState: createOpenaiState,
  api: createOpenaiApi,
  /**
   * Registers the OpenAI voiceover/translate/prompt-gen handlers with the registry.
   *
   * @param ctx - Plugin context (registry access via ctx.require).
   */
  onInit: ctx => {
    const registry = ctx.require(registryPlugin);
    registry.register("voiceover", "openai", createTtsHandler(ctx));
    registry.register("translate", "openai", createTranslateHandler(ctx));
    registry.register("prompt-gen", "openai", createPromptGenHandler(ctx));
  }
});
