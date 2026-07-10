/**
 * @file Batch 9 — journey: voice pipeline end-to-end (S33–S36).
 *
 * Author → estimate → run → verify audio through the REAL elevenlabs plugin
 * (fetch stubbed at the HTTP boundary), multi-file glob determinism, a
 * `defineBuild()` TS build file end-to-end, and one-off `generate()` parity
 * with a journaled run. Per-test tmp dirs keep `.moku/` out of the repo.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreConfig } from "../../src/config";
import { elevenlabsPlugin, registryPlugin } from "../../src/plugins";
import type { HandlerRequest, RunEvent } from "../../src/plugins/runner/types";
import type { VoiceoverHandler, VoiceoverRequest } from "../../src/plugins/voiceover/types";
import {
  buildFileYaml,
  buildFramework,
  collectStream,
  createFakeHandler,
  createFakeProviderPlugin
} from "./helpers";

/**
 * A successful ElevenLabs TTS response carrying `bytes` as the audio body
 * (pattern copied from `src/plugins/elevenlabs/__tests__/integration/`).
 */
function fakeElevenlabsAudioResponse(bytes: Uint8Array): Response {
  const fake = {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: () => Promise.resolve({}),
    arrayBuffer: () => Promise.resolve(bytes.buffer)
  };
  return fake as unknown as Response;
}

/**
 * Fixture plugin bridging the runner's `HandlerRequest` `{input, params}`
 * envelope onto the REAL registered elevenlabs `VoiceoverHandler`.
 *
 * KNOWN FRAMEWORK GAP (pinned in cross-registry-providers.test.ts S20): the
 * runner passes handlers the `{input, params}` envelope, but real provider
 * handlers read the flat task-contract request (`request.text` etc.), so a
 * build item naming `provider: elevenlabs` breaks at planning. This bridge
 * adapts ONLY the request/result envelope; everything else (buildfile →
 * runner → registry → real elevenlabs handler → HTTP boundary → store +
 * journal) is the real stack.
 */
function createBridgedElevenlabsPlugin() {
  return coreConfig.createPlugin("elevenlabsBridge", {
    depends: [registryPlugin, elevenlabsPlugin],
    onInit: ctx => {
      const registry = ctx.require(registryPlugin);

      // Audited cast: the registry transports handlers opaquely; elevenlabs
      // registered this exact handler under ("voiceover", "elevenlabs").
      const real = registry.resolve("voiceover", "elevenlabs") as VoiceoverHandler;

      registry.register("voiceover", "elevenlabs-bridged", {
        estimate: (request: HandlerRequest) =>
          real.estimate(request.input as unknown as VoiceoverRequest),
        execute: async (request: HandlerRequest, opts: { signal?: AbortSignal }) => {
          const result = await real.execute(request.input as unknown as VoiceoverRequest, opts);
          return { body: result.audio, mimeType: result.mimeType, costUsd: result.costUsd };
        }
      });
    }
  });
}

/**
 * A fake voiceover handler whose `execute()` result satisfies BOTH consumer
 * shapes: the runner's `{body, ...}` artifact contract and the voiceover
 * facade's `{audio, ...}` `VoiceoverResult`, so one registration serves a
 * one-off `generate()` and a journaled run identically (S36 parity).
 */
function createDualShapeVoiceoverHandler(costUsd: number) {
  const inner = createFakeHandler({ costUsd });
  return {
    estimate: inner.estimate,
    execute: async (request: unknown, opts: { signal?: AbortSignal }) => {
      const result = await inner.execute(request, opts);
      return { ...result, audio: result.body };
    },
    attempts: inner.attempts
  };
}

/** Narrows `records` to just the `item:queued` stream records. */
function queuedRecords(records: RunEvent[]) {
  return records.flatMap(record => (record.type === "item:queued" ? [record] : []));
}

describe("journey: voice pipeline", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-root-int-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  // ---------------------------------------------------------------------------
  // S33 — author → estimate → run → verify audio (real elevenlabs, stubbed fetch)
  // ---------------------------------------------------------------------------

  it("S33: authors, estimates, runs, and verifies audio through the real elevenlabs plugin", async () => {
    const audio = new Uint8Array([7, 8, 9]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeElevenlabsAudioResponse(audio)));

    // DEVIATION (defect pin above): the runner-envelope gap means the build
    // item routes through the thin bridge over the REAL elevenlabs handler.
    const pricePerChar = 0.001;
    const text = "Hello launch day";
    const app = buildFramework(tempDir, {
      providers: true,
      pluginConfigs: { elevenlabs: { priceOverrides: { eleven_multilingual_v2: pricePerChar } } },
      extraPlugins: [createBridgedElevenlabsPlugin()]
    }).createApp();
    await app.start();

    // Author: one voiceover item against the (bridged) elevenlabs provider.
    await writeFile(
      path.join(tempDir, "voice.moku.yaml"),
      buildFileYaml("voice-journey", [
        {
          task: "voiceover",
          provider: "elevenlabs-bridged",
          input: { text, voice: "voice-1" }
        }
      ])
    );
    const glob = path.join(tempDir, "*.moku.yaml");

    // Estimate: totalUsd comes from the real price table with the override.
    const estimate = await app.runner.estimate({ files: glob });
    expect(estimate.totalUsd).toBeGreaterThan(0);
    expect(estimate.totalUsd).toBeCloseTo(text.length * pricePerChar, 10);

    // Run: settles done with the single item committed.
    const result = await app.runner.run({ files: glob });
    expect(result.status).toBe("done");
    expect(result.totals.done).toBe(1);

    // Status report reflects the done run (RunStatusReport shape).
    const report = app.runner.status(result.runId);
    expect(report.runId).toBe(result.runId);
    expect(report.status).toBe("done");
    expect(report.totals).toMatchObject({ total: 1, done: 1, failed: 0, flagged: 0 });
    expect(report.totals.spendUsd).toBeCloseTo(text.length * pricePerChar, 10);
    expect(typeof report.updatedAt).toBe("number");

    // Verify audio: the CAS artifact is byte-identical to the stubbed body.
    const [doneItem] = app.probe.journal.listItems(result.runId, { status: "done" });
    if (!doneItem || doneItem.contentHash === null) {
      throw new Error("expected one done item with a contentHash");
    }
    expect(await app.probe.store.read(doneItem.contentHash)).toEqual(audio);

    await app.stop();
  });

  // ---------------------------------------------------------------------------
  // S34 — multi-file glob run, deterministic order
  // ---------------------------------------------------------------------------

  it("S34: multi-file glob loads and queues in deterministic sorted path order", async () => {
    const handler = createFakeHandler({ costUsd: 0.01 });
    const app = buildFramework(tempDir, {
      extraPlugins: [createFakeProviderPlugin("fakeProvider", "voiceover", "fake", handler)]
    }).createApp();
    await app.start();

    // Written b-first to prove ordering is sorted, not creation order.
    const bPath = path.join(tempDir, "b-second.moku.yaml");
    const aPath = path.join(tempDir, "a-first.moku.yaml");
    await writeFile(
      bPath,
      buildFileYaml("b-second", [
        { task: "voiceover", provider: "fake", input: { text: "beta", voice: "v1" } }
      ])
    );
    await writeFile(
      aPath,
      buildFileYaml("a-first", [
        { task: "voiceover", provider: "fake", input: { text: "alpha", voice: "v1" } }
      ])
    );
    const glob = path.join(tempDir, "*.moku.yaml");

    // loadGlob: one CompiledBuild per file, sorted path order (a before b).
    const compiled = await app.buildfile.loadGlob(glob);
    expect(compiled.map(build => build.file)).toEqual([aPath, bPath]);
    expect(compiled.map(build => build.spec.name)).toEqual(["a-first", "b-second"]);

    // Run both files, capturing the stream from before the run settles.
    const runPromise = app.runner.run({ files: glob });
    const records = await collectStream(app, runPromise);
    const result = await runPromise;
    expect(result.totals).toMatchObject({ total: 2, done: 2 });

    // item:queued order follows the sorted file order (a's item, then b's).
    const items = app.probe.journal.listItems(result.runId);
    const fileOf = new Map(items.map(item => [item.id, item.buildFile]));
    const queuedFiles = queuedRecords(records).map(record => fileOf.get(record.itemId));
    expect(queuedFiles).toEqual([aPath, bPath]);

    await app.stop();
  });

  // ---------------------------------------------------------------------------
  // S35 — defineBuild TS build file end-to-end
  // ---------------------------------------------------------------------------

  it("S35: a defineBuild() TS build file compiles and runs end-to-end", async () => {
    const handler = createFakeHandler({ costUsd: 0.02 });
    const app = buildFramework(tempDir, {
      extraPlugins: [createFakeProviderPlugin("fakeProvider", "voiceover", "fake", handler)]
    }).createApp();
    await app.start();

    // Author a TS build file importing defineBuild by relative specifier
    // (toImportSpecifier pattern from buildfile's own integration test).
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const definePath = path.resolve(testDir, "../../src/plugins/buildfile/define.ts");
    const relative = path.relative(tempDir, definePath).replaceAll("\\", "/");
    const importSpecifier = relative.startsWith(".") ? relative : `./${relative}`;
    const tsPath = path.join(tempDir, "build.moku.ts");
    await writeFile(
      tsPath,
      `import { defineBuild } from "${importSpecifier}";

export default defineBuild({
  version: 1,
  name: "ts-journey",
  items: [{ task: "voiceover", provider: "fake", input: { text: "hi from ts", voice: "v1" } }]
});
`
    );

    // compile() returns the validated spec with items intact.
    const compiled = await app.buildfile.compile({ path: tsPath });
    expect(compiled.spec.name).toBe("ts-journey");
    expect(compiled.spec.items).toHaveLength(1);
    expect(compiled.spec.items[0]).toMatchObject({ task: "voiceover", provider: "fake" });

    // The run over the TS glob settles done.
    const result = await app.runner.run({ files: path.join(tempDir, "*.moku.ts") });
    expect(result.status).toBe("done");
    expect(result.totals.done).toBe(1);

    // Journal rows carry the TS file's task/provider identity.
    const [item] = app.probe.journal.listItems(result.runId);
    if (!item) {
      throw new Error("expected one journaled item");
    }
    expect(item).toMatchObject({ task: "voiceover", provider: "fake", buildFile: tsPath });

    await app.stop();
  });

  // ---------------------------------------------------------------------------
  // S36 — one-off generate vs journaled run: parity and non-journaling
  // ---------------------------------------------------------------------------

  it("S36: one-off generate() journals nothing and estimates match the journaled run exactly", async () => {
    const costUsd = 0.05;
    const handler = createDualShapeVoiceoverHandler(costUsd);
    const app = buildFramework(tempDir, {
      extraPlugins: [createFakeProviderPlugin("fakeProvider", "voiceover", "fake", handler)]
    }).createApp();
    await app.start();

    // One-off generate: audio comes back, and NOTHING is journaled.
    const generated = await app.voiceover.generate(
      { text: "Hi", voice: "v1" },
      { provider: "fake" }
    );
    expect(generated.audio).toEqual(new TextEncoder().encode("artifact-1"));
    expect(generated.costUsd).toBe(costUsd);
    expect(handler.attempts()).toBe(1);
    expect(app.probe.journal.latestResumableRun()).toBeUndefined();

    // Journaled run over the same input.
    await writeFile(
      path.join(tempDir, "one-off.moku.yaml"),
      buildFileYaml("one-off-parity", [
        { task: "voiceover", provider: "fake", input: { text: "Hi", voice: "v1" } }
      ])
    );
    const result = await app.runner.run({ files: path.join(tempDir, "*.moku.yaml") });
    expect(result.status).toBe("done");

    // Parity: facade estimate === journaled estimatedCostUsd (same handler
    // estimate()), and the committed item's actualCostUsd is the same 0.05.
    const facade = app.voiceover.estimate({ text: "Hi", voice: "v1" }, { provider: "fake" });
    const [item] = app.probe.journal.listItems(result.runId, { status: "done" });
    if (!item) {
      throw new Error("expected one done item");
    }
    expect(facade.usd).toBe(costUsd);
    expect(item.estimatedCostUsd).toBe(facade.usd);
    expect(item.actualCostUsd).toBe(costUsd);

    await app.stop();
  });
});
