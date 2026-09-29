/**
 * Complex tier — Claude provider: text generation over the local Claude
 * Code CLI (`claude -p --output-format json`), plan-billed at an explicit $0.
 * Registers `prompt-gen/claude` in onInit. No events, no state.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { registryPlugin } from "../registry";
import { createClaudeApi } from "./api";
import { createPromptGenHandler } from "./prompt/handler";
import type { Config } from "./types";

const defaultConfig: Config = {
  bin: "claude",
  textModel: "",
  modelMap: {},
  timeoutMs: 600_000,
  workDir: ""
};

/**
 * claude — Complex tier text provider over the local Claude Code CLI.
 * Depends on registry (onInit registration); the promptGen and image
 * contracts are contract-file imports, not plugin edges.
 *
 * @see README.md
 */
export const claudePlugin = createPlugin("claude", {
  depends: [registryPlugin],
  config: defaultConfig,
  api: createClaudeApi,
  onInit: ctx => {
    ctx.require(registryPlugin).register("prompt-gen", "claude", createPromptGenHandler(ctx));
  }
});
