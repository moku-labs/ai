/**
 * `@moku-labs/ai` — a durable build system for AI-generated assets.
 * Declarative build files in, named artifacts out: any task × any provider,
 * resumable after a crash, incremental across runs, budget-gated.
 *
 * Plugins, in registration (dependency) order, and their options. Every
 * option has a default; override any of them per app with
 * `createApp({ pluginConfigs: { <plugin>: { ... } } })`. Core plugins
 * (`journal`, `store`, `limits`) are registered in `createCoreConfig` and injected as
 * `ctx.journal` / `ctx.store` / `ctx.limits`.
 *
 * | Plugin | Option | Default |
 * |---|---|---|
 * | journal (core) | `path` · `checkpointIntervalMs` · `busyTimeoutMs` | `".moku/journal.db"` · `30_000` · `5000` |
 * | store (core) | `dir` · `algo` | `".moku/store"` · `"sha256"` |
 * | limits (core) | `defaults` · `lanes` | `{ rpm: 60, concurrency: 4, breakerThreshold: 5, breakerCooldownMs: 30_000 }` · `{ "video/apimodels": { concurrency: 2, rpm: 20 } }`. A `lanes` override replaces the whole map: repeat this lane. |
 * | registry | — | — |
 * | buildfile | `defaultGlob` · `schemaPath` | `"**\/*.moku.yaml"` · `".moku/build.schema.json"` |
 * | runner | `maxAttempts` · `retryBaseMs` · `eventBufferSize` · `pollIntervalMs` · `jobTimeoutMs` · `maxActiveRuns` | `3` · `1000` · `10_000` · `5000` · `1_800_000` · `1` |
 * | voiceover | `defaultProvider` · `defaultFormat` | `"elevenlabs"` · `"mp3"` |
 * | translate | `defaultProvider` | `"openai"` |
 * | promptGen | `defaultProvider` · `fallback` | `"openai"` · `[]` |
 * | image | `defaultProvider` | `"codex"` |
 * | video | `defaultProvider` · `pollIntervalMs` | `"fal"` · `5000` |
 * | music | `defaultProvider` · `pollIntervalMs` | `"fal"` · `5000` |
 * | asset | `defaultProvider` · `pollIntervalMs` | `"ark"` · `3000` |
 * | elevenlabs | `apiKeyEnv` · `baseUrl` · `defaultModel` · `timeoutMs` · `priceOverrides` | `"ELEVENLABS_API_KEY"` · `"https://api.elevenlabs.io"` · `"eleven_multilingual_v2"` · `60_000` · `{}` |
 * | openai | `apiKeyEnv` · `baseUrl` · `models` · `timeoutMs` · `priceOverrides` | `"OPENAI_API_KEY"` · SDK default · `{ tts: "gpt-4o-mini-tts", chat: "gpt-4o-mini" }` · `60_000` · `{}` |
 * | codex | `bin` · `model` · `reasoningEffort` · `timeoutMs` · `workDir` · `priceOverrides` · `textModel` · `modelMap` | `"codex"` · `"gpt-6-astra"` · `"low"` · `600_000` · `".moku/tmp"` · `{}` · `""` · `{}` |
 * | claude | `bin` · `textModel` · `modelMap` · `timeoutMs` · `workDir` | `"claude"` · `""` · `{}` · `600_000` · `""` (OS temp dir) |
 * | fal | `apiKeyEnv` · `queueUrl` · `uploadUrl` · `upload` · `timeoutMs` · `priceOverrides` · `runUrl` · `imageDefaultModel` · `llmDefaultModel` · `pollMs` · `jobTimeoutMs` · `requestLog` | `"FAL_KEY"` · `"https://queue.fal.run"` · fal storage initiate URL · `"storage"` · `60_000` · `{}` · `"https://fal.run"` · `"gpt-image-2.5"` · `"anthropic/claude-opus-5.5"` · `2000` · `900_000` · `undefined` (off) |
 * | apimodels | `apiKeyEnv` · `baseUrl` · `assetGroup` · `timeoutMs` · `priceOverrides` | `"APIMODELS_API_KEY"` · `"https://api.apimodels.app/v1"` · `"moku-ai"` · `60_000` · `{}` |
 * | ark | `region` · `apiKeyEnv` · `accessKeyEnv` · `secretKeyEnv` · `baseUrl` · `controlUrl` · `groupId` · `groupName` · `timeoutMs` · `priceOverrides` · `cnyPerUsd` | `"intl"` · `"ARK_API_KEY"` · `"ARK_ACCESS_KEY"` · `"ARK_SECRET_KEY"` · `null` · `null` · `null` · `"moku-ai"` · `60_000` · `{}` · `7.1` |
 * | compose | `provider` · `maxRepairAttempts` | `"openai"` · `2` |
 * | cli | `plain` | `false` (auto on when not a TTY or `NO_COLOR`) |
 * | env (core) | `providers` | `[processEnv(), dotenv(".env.local")]`: shell first, then `.env.local` in the cwd |
 *
 * @example
 * ```ts
 * import { createApp } from "@moku-labs/ai";
 *
 * const app = createApp({ pluginConfigs: { fal: { upload: "data-uri" } } });
 * await app.start();
 * const { totalUsd } = await app.runner.estimate({ files: "ep01.moku.yaml" });
 * await app.runner.run({ files: "ep01.moku.yaml", maxCostUsd: totalUsd * 1.2 });
 * await app.runner.export({ outDir: "out" });
 * await app.stop();
 * ```
 */
// biome-ignore-all assist/source/organizeImports: manifest section order (Framework API → Plugins → Helpers → Types) is mandated by spec/04 §4
import { dotenv, processEnv } from "@moku-labs/common";
import { coreConfig, createCore } from "./config";
import {
  apimodelsPlugin,
  arkPlugin,
  assetPlugin,
  buildfilePlugin,
  claudePlugin,
  cliPlugin,
  codexPlugin,
  composePlugin,
  elevenlabsPlugin,
  falPlugin,
  imagePlugin,
  musicPlugin,
  openaiPlugin,
  promptGenPlugin,
  registryPlugin,
  runnerPlugin,
  translatePlugin,
  videoPlugin,
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
    imagePlugin,
    videoPlugin,
    musicPlugin,
    assetPlugin,
    elevenlabsPlugin,
    openaiPlugin,
    codexPlugin,
    claudePlugin,
    falPlugin,
    apimodelsPlugin,
    arkPlugin,
    composePlugin,
    cliPlugin
  ],
  // Framework default plugin configuration.
  // Consumer apps override specific values via createApp({ pluginConfigs: { ... } }).
  pluginConfigs: {
    // Provider keys (FAL_KEY, APIMODELS_API_KEY, ELEVENLABS_API_KEY, OPENAI_API_KEY, ARK_API_KEY, ARK_ACCESS_KEY, ARK_SECRET_KEY) and PATH:
    // the process environment first, then `.env.local` in the working directory.
    env: { providers: [processEnv(), dotenv(".env.local")] },
    // apimodels.app documents no rate limits: a conservative lane until real limits are known.
    limits: { lanes: { "video/apimodels": { concurrency: 2, rpm: 20 } } }
  }
});

// ─── Framework API ────────────────────────────────────────────
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

// ─── Plugins ──────────────────────────────────────────────────
export {
  apimodelsPlugin,
  arkPlugin,
  assetPlugin,
  buildfilePlugin,
  claudePlugin,
  cliPlugin,
  codexPlugin,
  composePlugin,
  elevenlabsPlugin,
  falPlugin,
  imagePlugin,
  journalPlugin,
  limitsPlugin,
  musicPlugin,
  openaiPlugin,
  promptGenPlugin,
  registryPlugin,
  runnerPlugin,
  storePlugin,
  translatePlugin,
  videoPlugin,
  voiceoverPlugin
} from "./plugins";

// ─── Helpers ──────────────────────────────────────────────────
export { defineBuild } from "./plugins/buildfile";
export { ASSET_MIME, encodeAssetRecord, parseAssetRecord } from "./plugins/asset/contract";
export { isPromptGenUnavailable, PromptGenUnavailableError } from "./plugins/promptGen/contract";

// ─── Types (per-plugin namespaces: `Runner.RunResult`, `Video.VideoRequest`, …) ──
export {
  Apimodels,
  Ark,
  Asset,
  Buildfile,
  Claude,
  Cli,
  Codex,
  Compose,
  Elevenlabs,
  Fal,
  Image,
  Journal,
  Limits,
  Music,
  Openai,
  PromptGen,
  Runner,
  Store,
  Translate,
  Video,
  Voiceover
} from "./plugins";
