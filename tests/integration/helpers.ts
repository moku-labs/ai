/**
 * @file Shared helpers for root integration tests (Batches 1–12).
 *
 * Created by Batch 1; every other batch imports from here and never edits it.
 * Signatures follow `.planning/build/integration-test-plan.md` ("helpers.ts
 * contract") exactly.
 */
import path from "node:path";
import type { EnvProvider } from "@moku-labs/common";
import { coreConfig, createCore } from "../../src/config";
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
} from "../../src/plugins";
import type { ExecutableHandler, RunEvent } from "../../src/plugins/runner/types";

/** Options shaping a `createFakeHandler` fake provider handler. */
export type FakeHandlerOptions = {
  /** Cost reported by both `estimate()` and successful `execute()`. */
  costUsd: number;
  /** Leading `execute()` calls that throw `{status: 500}` (retryable) before succeeding. */
  failuresBeforeSuccess?: number;
  /** Always throw `{status: 400}` (terminal). */
  terminalFailure?: boolean;
  /** Always throw `{kind: "content-policy"}` (flagged). */
  flagged?: boolean;
  /** `execute()` awaits this before resolving (in-flight simulation). */
  executeGate?: Promise<void>;
  /** Artifact bytes per attempt; default: utf8 `artifact-${attempt}`. */
  body?: (attempt: number) => Uint8Array;
  /** Sync callback at `execute()` entry (timing probes). */
  onExecuteStart?: () => void;
};

/** Builds a fake `ExecutableHandler` with scripted failures and an attempt counter. */
export function createFakeHandler(
  options: FakeHandlerOptions
): ExecutableHandler & { attempts: () => number } {
  let attempts = 0;
  const bodyFor =
    options.body ?? ((attempt: number) => new TextEncoder().encode(`artifact-${attempt}`));

  return {
    estimate: () => ({ usd: options.costUsd }),
    execute: async () => {
      attempts += 1;
      const attempt = attempts;
      options.onExecuteStart?.();

      // Optional in-flight gate: hold the attempt open until released.
      if (options.executeGate) {
        await options.executeGate;
      }

      // Scripted failure modes, checked most-specific first.
      if (options.flagged) {
        throw Object.assign(new Error("content policy"), { kind: "content-policy" });
      }
      if (options.terminalFailure) {
        throw Object.assign(new Error("bad request"), { status: 400 });
      }
      if (options.failuresBeforeSuccess !== undefined && attempt <= options.failuresBeforeSuccess) {
        throw Object.assign(new Error("server error"), { status: 500 });
      }

      return {
        body: bodyFor(attempt),
        mimeType: "application/octet-stream",
        costUsd: options.costUsd
      };
    },
    attempts: () => attempts
  };
}

/** Fixture plugin registering `handler` for (task, provider) in `onInit` via the registry. */
export function createFakeProviderPlugin(
  name: string,
  task: string,
  provider: string,
  handler: ExecutableHandler
) {
  return coreConfig.createPlugin(name, {
    depends: [registryPlugin],
    onInit: ctx => {
      ctx.require(registryPlugin).register(task, provider, handler);
    }
  });
}

/** Probe plugin exposing the core APIs (`ctx.journal` / `ctx.store` / `ctx.limits`) as `app.probe`. */
export function createProbePlugin() {
  return coreConfig.createPlugin("probe", {
    api: ctx => ({ journal: ctx.journal, store: ctx.store, limits: ctx.limits })
  });
}

/** Fixture plugin pushing every runner bus event payload into `sink` keyed by event name. */
export function createRunEventListenerPlugin(sink: Record<string, unknown[]>) {
  const push = (event: string, payload: unknown): void => {
    const bucket = sink[event] ?? [];
    sink[event] = bucket;
    bucket.push(payload);
  };

  return coreConfig.createPlugin("listener", {
    depends: [runnerPlugin],
    hooks: () => ({
      "run:progress": p => push("run:progress", p),
      "run:done": p => push("run:done", p),
      "run:failed": p => push("run:failed", p),
      "run:budget-stop": p => push("run:budget-stop", p),
      "run:paused": p => push("run:paused", p)
    })
  });
}

/** Options for {@link buildFramework}. */
export type BuildFrameworkOptions = {
  /** Deep-merged OVER the `{ journal: {path}, store: {dir} }` tempDir defaults. */
  pluginConfigs?: Record<string, unknown>;
  /** Fixture plugins, inserted after composePlugin, before cliPlugin. */
  extraPlugins?: unknown[];
  /** Default false; true adds elevenlabsPlugin + openaiPlugin + fixture EnvProvider wiring. */
  providers?: boolean;
  /** Default true; appends createProbePlugin() last. */
  probe?: boolean;
};

/**
 * Type-only reference assembling the full plugin set — never invoked at
 * runtime. Gives {@link buildFramework} a return type whose `createApp()`
 * surfaces every plugin API (incl. `app.probe`).
 */
function referenceFramework() {
  return createCore(coreConfig, {
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
      cliPlugin,
      createProbePlugin()
    ]
  });
}

/** Fully-typed framework shape returned by {@link buildFramework}: `{ createApp, createPlugin }`. */
export type TestFramework = ReturnType<typeof referenceFramework>;

/** True for a plain (non-array) object — the deep-merge recursion guard. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-merges `override` over `base` (plain objects recurse, everything else replaces). */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return merged;
}

/** Fixture `EnvProvider` resolving `vars` without touching real `process.env`. */
export function fixtureEnvProvider(vars: Record<string, string>): unknown {
  const provider: EnvProvider = { name: "integration-fixture", load: () => vars };
  return provider;
}

/**
 * Assembles a fresh framework with journal/store pinned under `tempDir` so
 * nothing writes `.moku/` into the repo. Plugin order: registry, buildfile,
 * runner, voiceover, translate, promptGen, [elevenlabs, openai if providers],
 * compose, ...extraPlugins, cli, [probe].
 */
export function buildFramework(tempDir: string, opts: BuildFrameworkOptions = {}): TestFramework {
  const { pluginConfigs = {}, extraPlugins = [], providers = false, probe = true } = opts;

  // Assemble the plugin list in the mandated order.
  const plugins: unknown[] = [
    registryPlugin,
    buildfilePlugin,
    runnerPlugin,
    voiceoverPlugin,
    translatePlugin,
    promptGenPlugin,
    ...(providers ? [elevenlabsPlugin, openaiPlugin] : []),
    composePlugin,
    ...extraPlugins,
    cliPlugin,
    ...(probe ? [createProbePlugin()] : [])
  ];

  // Tmp-dir defaults for the core plugins (settable only at createCore), plus
  // fixture API keys when the real provider plugins are wired in.
  const defaults: Record<string, unknown> = {
    journal: { path: path.join(tempDir, "journal.db") },
    store: { dir: path.join(tempDir, "store") },
    ...(providers
      ? {
          env: {
            providers: [
              fixtureEnvProvider({ ELEVENLABS_API_KEY: "test-key", OPENAI_API_KEY: "test-key" })
            ]
          }
        }
      : {})
  };

  return createCore(coreConfig, {
    plugins: plugins as Parameters<typeof createCore>[1]["plugins"],
    pluginConfigs: deepMerge(defaults, pluginConfigs)
  }) as unknown as TestFramework;
}

/** Renders a version-1 build-file YAML document from task/provider/input items. */
export function buildFileYaml(
  name: string,
  items: Array<{ task: string; provider: string; input: Record<string, string> }>
): string {
  const itemLines = items.flatMap(item => [
    `  - task: ${item.task}`,
    `    provider: ${item.provider}`,
    "    input:",
    ...Object.entries(item.input).map(([key, value]) => `      ${key}: ${value}`)
  ]);

  const header = [`version: 1`, `name: ${name}`, `items:`];
  const document = [...header, ...itemLines].join("\n");
  return `${document}\n`;
}

/** A promise with its `resolve` exposed — for gating in-flight fake handlers. */
export function createDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Consumes `app.runner.events()` starting BEFORE `runPromise` is awaited and
 * returns every record once the `terminal` record arrives.
 */
export async function collectStream(
  app: { runner: { events(): AsyncIterable<RunEvent> } },
  runPromise: Promise<unknown>
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];

  // Start consuming immediately so early records are not missed.
  const consuming = (async () => {
    for await (const event of app.runner.events()) {
      events.push(event);
      if (event.type === "terminal") {
        break;
      }
    }
  })();

  await Promise.all([consuming, runPromise]);
  return events;
}
