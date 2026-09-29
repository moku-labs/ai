/**
 * Standard tier — owns the asset capability contract (submit + poll a
 * portrait registration into an opaque `AssetRecord`) + typed one-off
 * facade app.asset.*. No events, no state, no lifecycle.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { registryPlugin } from "../registry";
import { createAssetApi } from "./api";
import type { Config } from "./types";

const defaultConfig: Config = { defaultProvider: "ark", pollIntervalMs: 3000 };

/**
 * asset — Standard tier plugin. Task contract owner + facade. Depends on registry.
 *
 * @see README.md
 */
export const assetPlugin = createPlugin("asset", {
  depends: [registryPlugin],
  config: defaultConfig,
  api: createAssetApi
});
