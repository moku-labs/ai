/**
 * Standard tier — owns the translate capability contract + typed one-off
 * facade app.translate.*.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { registryPlugin } from "../registry";
import { createTranslateApi } from "./api";
import type { Config } from "./types";

const defaultConfig: Config = { defaultProvider: "openai" };

/**
 * translate — Standard tier plugin. Task contract owner + facade. Depends on registry.
 *
 * @see README.md
 */
export const translatePlugin = createPlugin("translate", {
  depends: [registryPlugin],
  config: defaultConfig,
  api: createTranslateApi
});
