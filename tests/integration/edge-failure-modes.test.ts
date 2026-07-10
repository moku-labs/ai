/**
 * @file Batch 12 — edge failure modes (S45–S47): content-policy flagging,
 * missing provider API key, and buildfile edge inputs, all through the REAL
 * framework composition.
 *
 * Behavior pinned against src (deviations from the plan noted inline):
 * - `loadGlob` with zero matches THROWS the pinned two-line "No build files
 *   matched" error (buildfile/api.ts `noMatchesError`) — it does NOT return
 *   `[]` as the plan assumed.
 * - An empty-glob `runner.run()` therefore resolves (never rejects) with
 *   `{ status: "failed" }` and emits `run:failed` carrying that same pinned
 *   message (runner/api.ts `failRun`).
 * - `template()` quotes the name (`name: "starter"`, via JSON.stringify) —
 *   not the plan's unquoted `name: starter`.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFileYaml,
  buildFramework,
  createFakeHandler,
  createFakeProviderPlugin,
  createRunEventListenerPlugin,
  fixtureEnvProvider
} from "./helpers";

/** Per-item cost every fake handler reports for estimate() and execute(). */
const COST = 0.1;

/** The exact pinned missing-OPENAI-key error (openai/client.ts `missingApiKeyError`). */
const MISSING_OPENAI_KEY_MESSAGE =
  "[ai] OPENAI_API_KEY is not set.\n  Export it or set config.apiKeyEnv to the variable that holds your key.";

/** Pre-seeded sink for the five runner bus events. */
function createSink(): Record<string, unknown[]> {
  return {
    "run:progress": [],
    "run:done": [],
    "run:failed": [],
    "run:budget-stop": [],
    "run:paused": []
  };
}

/**
 * Consumes `events()` alongside `runPromise` and returns both the stream
 * records and the resolved run result (collectStream alone drops the result).
 */
async function runAndCollect(
  app: {
    runner: {
      run(options: { files?: string; maxCostUsd?: number }): Promise<unknown>;
      events(): AsyncIterable<{ type: string }>;
    };
  },
  options: { files?: string; maxCostUsd?: number }
) {
  const runPromise = app.runner.run(options);
  const events: Array<Record<string, unknown> & { type: string }> = [];

  // Start consuming immediately so early records are not missed.
  const consuming = (async () => {
    for await (const event of app.runner.events()) {
      events.push(event as Record<string, unknown> & { type: string });
      if (event.type === "terminal") break;
    }
  })();

  const [, result] = await Promise.all([consuming, runPromise]);
  return {
    events,
    result: result as { runId: string; status: string; totals: Record<string, number> }
  };
}

describe("edge failure modes — flagging, missing keys, buildfile edge inputs", () => {
  let tempDir: string;
  let cleanups: Array<() => Promise<unknown>>;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-root-int-"));
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups.toReversed()) {
      await cleanup();
    }
    await rm(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // S45 — content-policy flagged item: no retry, run still done
  // ---------------------------------------------------------------------------

  it("S45: a content-policy item is flagged once (no retries), and the run still completes done", async () => {
    const sink = createSink();
    const healthyHandler = createFakeHandler({ costUsd: COST });
    const flaggedHandler = createFakeHandler({ costUsd: COST, flagged: true });

    const framework = buildFramework(tempDir, {
      pluginConfigs: { runner: { maxAttempts: 3, retryBaseMs: 10, eventBufferSize: 10_000 } },
      extraPlugins: [
        createFakeProviderPlugin("fixtureHealthy", "fakeTask", "healthy", healthyHandler),
        createFakeProviderPlugin("fixturePoliced", "fakeTask", "policed", flaggedHandler),
        createRunEventListenerPlugin(sink)
      ]
    });
    const app = framework.createApp();
    await app.start();
    cleanups.push(() => app.stop());

    await writeFile(
      path.join(tempDir, "edge.moku.yaml"),
      buildFileYaml("edge", [
        { task: "fakeTask", provider: "healthy", input: { text: "ok" } },
        { task: "fakeTask", provider: "policed", input: { text: "nope" } }
      ])
    );

    const { events, result } = await runAndCollect(app, {
      files: path.join(tempDir, "*.moku.yaml")
    });

    // Stream: the policed item is flagged; NOTHING in the run retried or failed.
    const flaggedEvents = events.filter(e => e.type === "item:flagged");
    expect(flaggedEvents).toHaveLength(1);
    expect(events.filter(e => e.type === "item:retry")).toHaveLength(0);
    expect(events.filter(e => e.type === "item:failed")).toHaveLength(0);

    // Content-policy is terminal on the FIRST attempt — maxAttempts: 3 unused.
    expect(flaggedHandler.attempts()).toBe(1);

    // Run result: flagging does not fail the run.
    expect(result.status).toBe("done");
    expect(result.totals).toMatchObject({ total: 2, done: 1, flagged: 1, failed: 0 });

    // Journal: the item landed in `flagged` (markFlagged). Plan deviation:
    // the row's attemptCount stays 0 — journal/api.ts only increments
    // attempt_count on a retryable RE-QUEUE, never on a terminal first
    // attempt. The single attempt is proven by handler.attempts() above.
    const flaggedRows = app.probe.journal.listItems(result.runId, { status: "flagged" });
    expect(flaggedRows).toHaveLength(1);
    expect(flaggedRows[0]?.attemptCount).toBe(0);

    // Bus: the final (unconditional) run:progress flush carries flagged: 1.
    const lastProgress = sink["run:progress"]?.at(-1) as { flagged: number } | undefined;
    expect(lastProgress?.flagged).toBe(1);
    expect(sink["run:done"]).toHaveLength(1);
    expect(sink["run:failed"]).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // S46 — missing provider API key: pinned error, info() degrades gracefully
  // ---------------------------------------------------------------------------

  it("S46: without OPENAI_API_KEY, info() reports configured: false and generate() rejects with the pinned message — fetch never called", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("fetch must never be called without an API key");
    });
    vi.stubGlobal("fetch", fetchSpy);

    // providers: true wires the REAL elevenlabs + openai plugins; the env
    // fixture deliberately omits OPENAI_API_KEY (arrays replace on merge).
    const framework = buildFramework(tempDir, {
      providers: true,
      pluginConfigs: {
        env: { providers: [fixtureEnvProvider({ ELEVENLABS_API_KEY: "test-key" })] }
      }
    });
    const app = framework.createApp();
    await app.start();
    cleanups.push(() => app.stop());

    // info() degrades gracefully: reports unconfigured, never throws.
    const info = app.openai.info();
    expect(info).toMatchObject({ provider: "openai", configured: false });
    expect(info.models).toMatchObject({ tts: expect.any(String), chat: expect.any(String) });

    // generate() rejects lazily with the exact pinned two-line message.
    await expect(
      app.voiceover.generate({ text: "Hi", voice: "alloy" }, { provider: "openai" })
    ).rejects.toThrow(MISSING_OPENAI_KEY_MESSAGE);

    // The HTTP boundary was never reached.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // S47 — buildfile edge inputs: malformed YAML, empty glob, schema/template
  // ---------------------------------------------------------------------------

  it("S47: malformed build file, empty glob, empty-glob run, jsonSchema and template all behave per the pinned contracts", async () => {
    const sink = createSink();
    const framework = buildFramework(tempDir, {
      extraPlugins: [createRunEventListenerPlugin(sink)]
    });
    const app = framework.createApp();
    await app.start();
    cleanups.push(() => app.stop());

    // compile: a schema-invalid build file rejects with the pinned two-line
    // error naming the file and the first validation issue.
    const badPath = path.join(tempDir, "bad.moku.yaml");
    await writeFile(badPath, 'version: 1\nitems: "not-a-list"\n');
    await expect(app.buildfile.compile({ path: badPath })).rejects.toThrow(
      `[ai] Build file "${badPath}" is invalid.`
    );

    // loadGlob: zero matches THROWS the pinned "No build files matched"
    // error (buildfile/api.ts) — plan deviation: it does NOT return [].
    const noMatch = path.join(tempDir, "nomatch/*.yaml");
    await expect(app.buildfile.loadGlob(noMatch)).rejects.toThrow(
      `[ai] No build files matched "${noMatch}".\n  Run "moku new" to create one.`
    );

    // Empty-glob run: run() resolves (never rejects) with a failed, empty
    // run and emits run:failed carrying the same pinned message.
    const { events, result } = await runAndCollect(app, { files: noMatch });
    expect(result.status).toBe("failed");
    expect(result.totals).toMatchObject({ total: 0, done: 0, failed: 0, flagged: 0 });
    expect(events.at(-1)).toMatchObject({ type: "terminal", status: "failed" });
    expect(app.probe.journal.getRun(result.runId)?.status).toBe("failed");
    expect(sink["run:failed"]).toHaveLength(1);
    expect(sink["run:failed"]?.[0]).toMatchObject({
      runId: result.runId,
      error: `[ai] No build files matched "${noMatch}".\n  Run "moku new" to create one.`
    });

    // jsonSchema: a JSON Schema object exposing the build-spec properties.
    const schema = app.buildfile.jsonSchema() as {
      properties?: Record<string, unknown>;
    };
    expect(schema).toBeTypeOf("object");
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(["version", "name", "items"])
    );

    // template: modeline + $schema key + the (quoted) name; itself valid —
    // plan deviation: the name is JSON.stringify-quoted in source.
    const template = app.buildfile.template({ name: "starter" });
    expect(template).toContain("# yaml-language-server: $schema=");
    expect(template).toContain("$schema:");
    expect(template).toContain('name: "starter"');
    const compiled = await app.buildfile.compile({ text: template, lang: "yaml" });
    expect(compiled.spec.name).toBe("starter");
  });
});
