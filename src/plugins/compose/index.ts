/**
 * Standard tier — prompt → validated build file (YAML or defineBuild() script)
 * via the promptGen facade + buildfile IR.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { buildfilePlugin } from "../buildfile";
import { promptGenPlugin } from "../promptGen";
import { createComposeApi } from "./api";
import type { Config } from "./types";

const defaultConfig: Config = { provider: "openai", maxRepairAttempts: 2 };

/**
 * compose — Standard tier plugin. Depends on buildfile, promptGen (NOT registry).
 *
 * @see README.md
 */
export const composePlugin = createPlugin("compose", {
  depends: [buildfilePlugin, promptGenPlugin],
  config: defaultConfig,
  api: createComposeApi
});
