/**
 * Standard tier — owns the prompt-gen capability contract + typed facade
 * app.promptGen.* (minimal M0 scope). Registry/task key: "prompt-gen".
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { registryPlugin } from "../registry";
import { createPromptGenApi } from "./api";
import type { Config } from "./types";

const defaultConfig: Config = { defaultProvider: "openai" };

/**
 * promptGen — Standard tier plugin. Task contract owner + facade. Depends on registry.
 *
 * @see README.md
 */
export const promptGenPlugin = createPlugin("promptGen", {
  depends: [registryPlugin],
  config: defaultConfig,
  api: createPromptGenApi
});
