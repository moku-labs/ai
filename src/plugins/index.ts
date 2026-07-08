/**
 * Plugin barrel — re-exports all framework plugin instances and types.
 * Helpers are NOT exported here — see src/index.ts.
 */
// biome-ignore-all assist/source/organizeImports: two-section barrel layout (Instances → Types) is mandated by the skeleton spec

// ─── Plugin Instances ────────────────────────────────────────
export { buildfilePlugin } from "./buildfile";
export { cliPlugin } from "./cli";
export { composePlugin } from "./compose";
export { elevenlabsPlugin } from "./elevenlabs";
export { journalPlugin } from "./journal";
export { limitsPlugin } from "./limits";
export { openaiPlugin } from "./openai";
export { promptGenPlugin } from "./promptGen";
export { registryPlugin } from "./registry";
export { runnerPlugin } from "./runner";
export { storePlugin } from "./store";
export { translatePlugin } from "./translate";
export { voiceoverPlugin } from "./voiceover";

// ─── Plugin Types (namespace re-exports) ─────────────────────
// Consumers access types as PluginName.Config, PluginName.Api, etc.
export * as Buildfile from "./buildfile/types";
export * as Cli from "./cli/types";
export * as Compose from "./compose/types";
export * as Elevenlabs from "./elevenlabs/types";
export * as Journal from "./journal/types";
export * as Limits from "./limits/types";
export * as Openai from "./openai/types";
export * as PromptGen from "./promptGen/types";
export * as Runner from "./runner/types";
export * as Store from "./store/types";
export * as Translate from "./translate/types";
export * as Voiceover from "./voiceover/types";
