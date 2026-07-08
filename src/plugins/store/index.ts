/**
 * Core plugin (Standard tier) — content-addressed artifact store:
 * crash-durable CAS writes, integrity-verified reads. ctx.store.
 *
 * @see README.md
 */
import { createCorePlugin } from "@moku-labs/core";
import { createStoreApi } from "./api";
import { createStoreState } from "./state";
import type { Config } from "./types";

const defaultConfig: Config = { dir: ".moku/store", algo: "sha256" };

/**
 * store — Core plugin (Standard tier). Content-addressed artifact store; injected as ctx.store.
 *
 * @see README.md
 */
export const storePlugin = createCorePlugin("store", {
  config: defaultConfig,
  createState: createStoreState,
  api: createStoreApi
});
