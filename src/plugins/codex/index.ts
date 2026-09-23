/**
 * Standard tier — Codex provider: image generation over the local Codex CLI
 * (`codex exec`), plan-billed at an explicit $0. Registers `image/codex` in
 * onInit. No events.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { registryPlugin } from "../registry";
import { createCodexApi } from "./api";
import { createImageHandler } from "./image/handler";
import { createCodexState } from "./state";
import type { Config } from "./types";

const defaultConfig: Config = {
  bin: "codex",
  model: "gpt-6-astra",
  reasoningEffort: "low",
  timeoutMs: 600_000,
  workDir: ".moku/tmp",
  priceOverrides: {}
};

/**
 * codex — Standard tier image provider. Depends on registry (onInit
 * registration), like the elevenlabs/openai providers; the `image` contract is
 * a type-only import.
 *
 * @see README.md
 */
export const codexPlugin = createPlugin("codex", {
  depends: [registryPlugin],
  config: defaultConfig,
  createState: createCodexState,
  api: createCodexApi,
  /**
   * Registers the codex image handler with the registry.
   *
   * @param ctx - Plugin context (registry access via ctx.require).
   * @example
   * ```ts
   * app.image.providers(); // ["codex", ...]
   * ```
   */
  onInit: ctx => {
    ctx.require(registryPlugin).register("image", "codex", createImageHandler(ctx));
  }
});
