/**
 * Complex tier — the `moku` command surface: mountable aiCommands tree +
 * post-start dispatch() returning the exit-code contract (no lifecycle, OQ1).
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { buildfilePlugin } from "../buildfile";
import { composePlugin } from "../compose";
import { runnerPlugin } from "../runner";
import { createCliApi } from "./api";
import type { Config } from "./types";

const defaultConfig: Config = { plain: false };

/**
 * cli — Complex tier plugin. Exit codes: 0 ok · 1 failure · 2 validation ·
 * 3 usage · 4 paused · 5 budget stop. Depends on runner, buildfile, compose.
 *
 * @see README.md
 */
export const cliPlugin = createPlugin("cli", {
  depends: [runnerPlugin, buildfilePlugin, composePlugin],
  config: defaultConfig,
  api: createCliApi
});
