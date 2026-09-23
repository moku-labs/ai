/**
 * @file Batch 7 — cross-plugin: compose chains (S25–S28).
 *
 * Exercises the compose plugin against the full default framework: promptGen
 * → buildfile validation (S25), the bounded repair loop + pinned exhaustion
 * error (S26), emit:"script" round-tripping through buildfile's TS loader
 * (S27), and composed output executing end-to-end through the runner (S28).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreConfig } from "../../src/config";
import { registryPlugin } from "../../src/plugins";
import type { PromptGenHandler } from "../../src/plugins/promptGen/types";
import type { RunEvent } from "../../src/plugins/runner/types";
import {
  buildFramework,
  collectStream,
  createFakeHandler,
  createFakeProviderPlugin
} from "./helpers";

// ---------------------------------------------------------------------------
// Canned prompt-gen outputs. The registered handler follows promptGen's OWN
// contract (PromptGenHandler: execute -> { text, costUsd }) — NOT the runner's
// ExecutableHandler — so a local fixture is used instead of helpers'
// createFakeProviderPlugin for the prompt-gen side.
// ---------------------------------------------------------------------------

/** Valid build-file YAML: two voiceover lines routed at the fake provider. */
const VALID_YAML = [
  "version: 1",
  "name: demo",
  "items:",
  "  - task: voiceover",
  "    provider: fake",
  "    input:",
  "      text: first line",
  "      voice: nova",
  "  - task: voiceover",
  "    provider: fake",
  "    input:",
  "      text: second line",
  "      voice: nova",
  ""
].join("\n");

/** Invalid build-file YAML: `version: 2` fails the z.literal(1) IR check. */
const INVALID_YAML = "version: 2\nname: broken\nitems: []\n";

/** Cost each canned prompt-gen call reports. */
const CANNED_COST_USD = 0.001;

/** Pinned two-line exhaustion error for 2 total attempts (maxRepairAttempts: 1). */
const EXHAUSTED_ERROR_TWO_ATTEMPTS =
  '[ai] Compose could not produce a valid build file after 2 attempts.\n  Refine the prompt or write the build file manually with "moku new".';

/**
 * Builds a PromptGenHandler that replays `outputs` in order (clamping to the
 * last entry once exhausted) and counts execute() calls.
 */
function createScriptedPromptGenHandler(
  outputs: readonly string[]
): PromptGenHandler & { calls: () => number } {
  let calls = 0;

  return {
    estimate: () => ({ usd: CANNED_COST_USD }),
    execute: async () => {
      const index = Math.min(calls, outputs.length - 1);
      calls += 1;
      return { text: outputs[index] ?? "", costUsd: CANNED_COST_USD };
    },
    calls: () => calls
  };
}

/** Fixture plugin registering `handler` as the "prompt-gen"/"canned" provider. */
function createCannedPromptGenPlugin(handler: PromptGenHandler) {
  return coreConfig.createPlugin("canned-prompt-gen", {
    depends: [registryPlugin],
    onInit: ctx => {
      ctx.require(registryPlugin).register("prompt-gen", "canned", handler);
    }
  });
}

describe("cross-plugin: compose chains", () => {
  let tempDir: string;
  const startedApps: Array<{ stop: () => Promise<void> }> = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-root-int-"));
  });

  afterEach(async () => {
    // Stop every started app first so SQLite handles close before the rm.
    for (const app of startedApps.splice(0)) {
      await app.stop();
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  /** Builds + starts a framework app wired with a canned prompt-gen provider. */
  async function startComposeApp(
    dir: string,
    promptGenHandler: PromptGenHandler,
    opts: { maxRepairAttempts?: number; extraPlugins?: unknown[] } = {}
  ) {
    const framework = buildFramework(dir, {
      pluginConfigs: {
        compose: { provider: "canned", maxRepairAttempts: opts.maxRepairAttempts ?? 1 }
      },
      extraPlugins: [createCannedPromptGenPlugin(promptGenHandler), ...(opts.extraPlugins ?? [])]
    });

    const app = framework.createApp();
    await app.start();
    startedApps.push(app);
    return app;
  }

  it("S25: compose happy path — promptGen output validates through buildfile", async () => {
    const handler = createScriptedPromptGenHandler([VALID_YAML]);
    const app = await startComposeApp(tempDir, handler);

    const result = await app.compose.compose({ prompt: "two voiceover lines", emit: "build" });

    // The returned spec is the validated canned build file.
    expect(result.spec.name).toBe("demo");
    expect(result.spec.items).toHaveLength(2);

    // Emitted text is YAML with version: 1 and round-trips through buildfile.compile.
    expect(result.text).toContain("version: 1");
    const recompiled = await app.buildfile.compile({ text: result.text, lang: "yaml" });
    expect(recompiled.spec).toEqual(result.spec);

    // costUsd surfaced from the fake handler (single attempt).
    expect(handler.calls()).toBe(1);
    expect(result.costUsd).toBe(CANNED_COST_USD);
  });

  it("S26: repair loop recovers from one invalid attempt, then exhausts with the pinned error", async () => {
    // Success case: invalid on call 1, valid on call 2 — one repair attempt suffices.
    const repairable = createScriptedPromptGenHandler([INVALID_YAML, VALID_YAML]);
    const okDir = path.join(tempDir, "repair-ok");
    await mkdir(okDir, { recursive: true });
    const okApp = await startComposeApp(okDir, repairable, { maxRepairAttempts: 1 });

    const result = await okApp.compose.compose({ prompt: "two voiceover lines", emit: "build" });

    expect(repairable.calls()).toBe(2);
    expect(result.spec.version).toBe(1);
    expect(result.spec.name).toBe("demo");
    // Cost accumulates across BOTH attempts (failed + repaired).
    expect(result.costUsd).toBeCloseTo(2 * CANNED_COST_USD, 10);

    // Failure case: a second app whose provider is always invalid — compose
    // rejects with the pinned two-line error and never returns an invalid spec.
    const alwaysInvalid = createScriptedPromptGenHandler([INVALID_YAML]);
    const failDir = path.join(tempDir, "repair-fail");
    await mkdir(failDir, { recursive: true });
    const failApp = await startComposeApp(failDir, alwaysInvalid, { maxRepairAttempts: 1 });

    const error = await failApp.compose
      .compose({ prompt: "two voiceover lines", emit: "build" })
      .then(
        () => undefined,
        (error_: unknown) => error_
      );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(EXHAUSTED_ERROR_TWO_ATTEMPTS);
    expect(alwaysInvalid.calls()).toBe(2);
  });

  it('S27: emit:"script" produces a compilable defineBuild module honoring the name override', async () => {
    const handler = createScriptedPromptGenHandler([VALID_YAML]);
    const app = await startComposeApp(tempDir, handler);

    const result = await app.compose.compose({
      prompt: "two voiceover lines",
      emit: "script",
      name: "my-build"
    });

    expect(result.text).toContain("defineBuild(");

    // Patch the emitted "@moku-labs/ai" import to the real source path so the
    // temp-dir script resolves, then compile it through buildfile's TS loader.
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const definePath = path.resolve(testDir, "../../src/plugins/buildfile/define.ts");
    const importSpecifier = pathToFileURL(definePath).href;
    const patchedText = result.text.replace(
      'import { defineBuild } from "@moku-labs/ai";',
      `import { defineBuild } from "${importSpecifier}";`
    );
    const scriptPath = path.join(tempDir, "gen.moku.ts");
    await writeFile(scriptPath, patchedText);

    const compiled = await app.buildfile.compile({ path: scriptPath });

    expect(compiled.spec.name).toBe("my-build");
    expect(compiled.spec).toEqual(result.spec);
  });

  it("S28: composed output executes end-to-end through the runner", async () => {
    // Fake voiceover/"fake" ExecutableHandler catches the composed items.
    const voiceoverHandler = createFakeHandler({ costUsd: 0.01 });
    const promptGen = createScriptedPromptGenHandler([VALID_YAML]);
    const app = await startComposeApp(tempDir, promptGen, {
      extraPlugins: [
        createFakeProviderPlugin("fake-voiceover", "voiceover", "fake", voiceoverHandler)
      ]
    });

    // compose emit:"build" -> write text to disk -> run it through the runner.
    const composed = await app.compose.compose({ prompt: "two voiceover lines", emit: "build" });
    const buildPath = path.join(tempDir, "composed.yaml");
    await writeFile(buildPath, composed.text);

    const runPromise = app.runner.run({ files: buildPath });
    const events = await collectStream(app, runPromise);
    const runResult = await runPromise;

    // The run completes and every composed item is done.
    expect(runResult.status).toBe("done");
    expect(runResult.totals.done).toBe(composed.spec.items.length);
    expect(runResult.totals.failed).toBe(0);

    // Each artifact landed in the CAS — buildfile→compose and registry→runner meet.
    const doneEvents = events.filter(
      (event): event is Extract<RunEvent, { type: "item:done" }> => event.type === "item:done"
    );
    expect(doneEvents).toHaveLength(composed.spec.items.length);
    for (const event of doneEvents) {
      expect(await app.probe.store.has(event.contentHash)).toBe(true);
    }
  });
});
