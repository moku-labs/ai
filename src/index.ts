/**
 * @file `@moku-labs/ai` — durable build system for AI-generated assets.
 */
import { coreConfig, createCore } from "./config";
import {
  buildfilePlugin,
  cliPlugin,
  composePlugin,
  elevenlabsPlugin,
  openaiPlugin,
  promptGenPlugin,
  registryPlugin,
  runnerPlugin,
  translatePlugin,
  voiceoverPlugin
} from "./plugins";

const framework = createCore(coreConfig, {
  // Dependency order: every plugin appears after everything it depends on.
  plugins: [
    registryPlugin,
    buildfilePlugin,
    runnerPlugin,
    voiceoverPlugin,
    translatePlugin,
    promptGenPlugin,
    elevenlabsPlugin,
    openaiPlugin,
    composePlugin,
    cliPlugin
  ],
  // Framework default plugin configuration.
  // Consumer apps override specific values via createApp({ pluginConfigs: { ... } }).
  pluginConfigs: {}
});

// ─── Plugins + Types ──────────────────────────────────────────
export * from "./plugins";

// ─── Framework API + Plugin Helpers ──────────────────────────
/**
 * Creates a Layer-3 consumer app composed on `@moku-labs/ai`.
 *
 * @example
 * ```ts
 * const app = createApp({});
 * await app.start();
 * ```
 */
export const createApp = framework.createApp;

/**
 * Plugin factory for Layer-3 consumers authoring custom plugins against this framework.
 *
 * @example
 * ```ts
 * const myPlugin = createPlugin("my", { api: () => ({}) });
 * ```
 */
export const createPlugin = framework.createPlugin;

export { defineBuild } from "./plugins/buildfile";
