/**
 * @file Framework configuration — Config + Events types, core plugin registration.
 */
import { envPlugin, logPlugin } from "@moku-labs/common";
import { createCoreConfig } from "@moku-labs/core";
import { journalPlugin } from "./plugins/journal";
import { limitsPlugin } from "./plugins/limits";
import { storePlugin } from "./plugins/store";

/**
 * Global configuration shape for the framework.
 * Empty by ratified decision — all configuration is per-plugin.
 */
// biome-ignore lint/complexity/noBannedTypes: ratified — configuration is per-plugin at M0
export type Config = {};

/**
 * Framework-level event contract.
 * Empty — runner declares its own events via the register-callback pattern.
 */
// biome-ignore lint/complexity/noBannedTypes: ratified — plugin-declared events only at M0
export type Events = {};

export const coreConfig = createCoreConfig<
  Config,
  Events,
  [
    typeof logPlugin,
    typeof envPlugin,
    typeof journalPlugin,
    typeof storePlugin,
    typeof limitsPlugin
  ]
>("ai", {
  config: {},
  plugins: [logPlugin, envPlugin, journalPlugin, storePlugin, limitsPlugin]
});

/**
 * Framework plugin factory — creates typed regular plugins for `@moku-labs/ai`.
 * Plugin files import THIS (from ../../config), never `@moku-labs/core`.
 *
 * @example
 * ```ts
 * export const myPlugin = createPlugin("my", { api: () => ({}) });
 * ```
 */
export const createPlugin = coreConfig.createPlugin;

/**
 * Framework assembler — consumed by src/index.ts to build the framework instance.
 *
 * @example
 * ```ts
 * const framework = createCore(coreConfig, { plugins: [] });
 * ```
 */
export const createCore = coreConfig.createCore;
