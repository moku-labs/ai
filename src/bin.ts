#!/usr/bin/env node
/**
 * @file `moku` bin entry — a Layer-3 consumer of `@moku-labs/ai` (ratified OQ1).
 *
 * createApp → start → cli.dispatch(argv) → stop → process.exit(code).
 * Imports ONLY the framework's public entry — never `@moku-labs/core`, never plugin internals.
 */
import { createApp } from "./index";

const app = createApp({});
await app.start();
const code = await app.cli.dispatch(process.argv.slice(2));
await app.stop();
process.exit(code);
