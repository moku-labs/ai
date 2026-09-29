/**
 * Standard tier — Codex provider: image generation and prompt-gen over the
 * local Codex CLI (`codex exec`), plan-billed at an explicit $0. Registers
 * `image/codex` then `prompt-gen/codex` in onInit. No events.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { registryPlugin } from "../registry";
import { createCodexApi } from "./api";
import { createImageHandler } from "./image/handler";
import { createPromptGenHandler } from "./prompt/handler";
import { createCodexState } from "./state";
import type { Config } from "./types";

const defaultConfig: Config = {
  bin: "codex",
  model: "gpt-6-astra",
  reasoningEffort: "low",
  timeoutMs: 600_000,
  workDir: ".moku/tmp",
  priceOverrides: {},
  textModel: "",
  modelMap: {}
};

/**
 * codex — Standard tier image and prompt-gen provider. Depends on registry
 * (onInit registration); the task contracts are plain imports, no depends edge.
 *
 * @see README.md
 */
export const codexPlugin = createPlugin("codex", {
  depends: [registryPlugin],
  config: defaultConfig,
  createState: createCodexState,
  api: createCodexApi,
  /**
   * Registers the image handler, then the prompt-gen handler.
   *
   * @param ctx - Plugin context (registry access via ctx.require).
   */
  onInit: ctx => {
    const registry = ctx.require(registryPlugin);
    registry.register("image", "codex", createImageHandler(ctx));
    registry.register("prompt-gen", "codex", createPromptGenHandler(ctx));
  }
});
