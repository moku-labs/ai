/**
 * Complex tier — Anthropic provider via the official SDK: prompt-gen over
 * the Messages API. Registers `("prompt-gen", "anthropic")` in onInit.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { registryPlugin } from "../registry";
import { createAnthropicApi } from "./api";
import { createPromptGenHandler } from "./prompt-gen/handler";
import { createAnthropicState } from "./state";
import type { Config } from "./types";

const defaultConfig: Config = {
  apiKeyEnv: "ANTHROPIC_API_KEY",
  model: "claude-opus-5-5",
  maxTokens: 32_000,
  timeoutMs: 900_000,
  priceOverrides: {}
};

/**
 * anthropic — Complex tier provider plugin. Depends on registry (one
 * `register("prompt-gen", "anthropic", …)` in onInit). Emits no events.
 *
 * @see README.md
 */
export const anthropicPlugin = createPlugin("anthropic", {
  depends: [registryPlugin],
  config: defaultConfig,
  createState: createAnthropicState,
  api: createAnthropicApi,
  /**
   * Registers the Anthropic prompt-gen handler with the registry.
   *
   * @param ctx - Plugin context (registry access via ctx.require).
   * @example
   * ```ts
   * app.promptGen.providers(); // [..., "anthropic"]
   * ```
   */
  onInit: ctx => {
    ctx.require(registryPlugin).register("prompt-gen", "anthropic", createPromptGenHandler(ctx));
  }
});
