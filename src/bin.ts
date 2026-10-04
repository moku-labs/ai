#!/usr/bin/env node
/**
 * @file `moku` bin entry — a Layer-3 consumer of `@moku-labs/ai` (ratified OQ1).
 *
 * loadProjectConfig → createApp(options) → start → cli.dispatch(argv) → stop → process.exit(code).
 * A config that does not load prints its message and exits 3 (usage) before any app exists.
 * Imports ONLY the framework's public entry plus the cli plugin's project-config loader — never
 * `@moku-labs/core`, never other plugin internals.
 */
import { Cli, createApp } from "./index";
import { loadProjectConfig, renderLoadError } from "./plugins/cli/project-config";

// Load moku.config.{ts,mts,js,mjs} or --config; a broken config stops here.
const loaded = await loadProjectConfig(process.argv.slice(2), process.cwd());
if (!loaded.ok) {
  renderLoadError(loaded.message);
  process.exit(Cli.EXIT_CODES.usage);
}

// Run the command against an app built from the project config.
const app = createApp(loaded.options);
await app.start();
const code = await app.cli.dispatch(loaded.argv);
await app.stop();
process.exit(code);
