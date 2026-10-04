import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { coreConfig, createCore, createPlugin } from "../../../../config";
import { buildfilePlugin } from "../../../buildfile";
import { registryPlugin } from "../../../registry";
import { runnerPlugin } from "../../../runner";
import type { SfxHandler, SfxRequest } from "../../contract";
import { sfxPlugin } from "../../index";
import type { SfxApi } from "../../types";

/** mp3 bytes the fake provider returns ("ID3" header + a marker). */
const CHIME = new Uint8Array([73, 68, 51, 4]);

/**
 * A fake sfx handler that records the requests it executed.
 *
 * @returns The handler and its call log.
 */
function fakeHandler(): { handler: SfxHandler; calls: SfxRequest[] } {
  const calls: SfxRequest[] = [];
  return {
    calls,
    handler: {
      estimate: request => ({ usd: Math.ceil((request.durationMs ?? 1000) / 1000) * 0.12 }),
      execute: async request => {
        calls.push(request);
        return { audio: CHIME, mimeType: "audio/mpeg", costUsd: 0.12 };
      }
    }
  };
}

/**
 * Real app: registry + buildfile + runner + sfx + one fake provider registered
 * in `onInit`, core plugins pinned under `tempDir`.
 *
 * @param tempDir - Directory for the journal and store.
 * @param handler - The fake sfx handler.
 * @returns A started app.
 */
async function startApp(tempDir: string, handler: SfxHandler) {
  const fakeProvider = createPlugin("fakeSfxProvider", {
    depends: [registryPlugin, sfxPlugin],
    onInit: ctx => {
      ctx.require(registryPlugin).register("sfx", "fake", handler);
    }
  });
  const app = createCore(coreConfig, {
    plugins: [registryPlugin, buildfilePlugin, runnerPlugin, sfxPlugin, fakeProvider],
    pluginConfigs: {
      journal: { path: path.join(tempDir, "journal.db") },
      store: { dir: path.join(tempDir, "store") },
      runner: { retryBaseMs: 1, pollIntervalMs: 1 },
      sfx: { defaultProvider: "fake" }
    }
  }).createApp();
  await app.start();
  return app;
}

/** Build file: one sfx item routed to the fake provider. */
const SFX_YAML = `version: 1
name: game
items:
  - id: coin-pickup
    task: sfx
    provider: fake
    input: { prompt: "coin pickup, bright chime", model: eleven_text_to_sound_v2, durationMs: 600 }
`;

describe("sfx: through a real app", () => {
  let tempDir: string;
  const stops: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "sfx-int-"));
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("generates, estimates and lists providers through app.sfx", async () => {
    const { handler, calls } = fakeHandler();
    const app = await startApp(tempDir, handler);
    stops.push(() => app.stop());

    const hit = await app.sfx.generate({
      prompt: "sword hit, metallic",
      model: "eleven_text_to_sound_v2",
      durationMs: 800
    });

    expect(hit).toEqual({ audio: CHIME, mimeType: "audio/mpeg", costUsd: 0.12 });
    expect(calls).toHaveLength(1);
    expect(
      app.sfx.estimate({ prompt: "x", model: "eleven_text_to_sound_v2", durationMs: 2000 }).usd
    ).toBeCloseTo(0.24);
    expect(app.sfx.providers()).toEqual(["fake"]);
  });

  it("throws the two-line unknown-provider error for an unregistered provider", async () => {
    const app = await startApp(tempDir, fakeHandler().handler);
    stops.push(() => app.stop());

    expect(() => app.sfx.estimate({ prompt: "p", model: "m" }, { provider: "acme" })).toThrow(
      '[ai] No sfx provider named "acme" is registered.\n  Available: fake.'
    );
  });

  it("a runner build of an sfx item exports <label>.mp3", async () => {
    const { handler, calls } = fakeHandler();
    const app = await startApp(tempDir, handler);
    stops.push(() => app.stop());
    await writeFile(path.join(tempDir, "game.moku.yaml"), SFX_YAML);

    const result = await app.runner.run({ files: path.join(tempDir, "*.moku.yaml") });
    const exported = await app.runner.export({ outDir: path.join(tempDir, "out") });

    expect(result).toMatchObject({ status: "done", totals: { total: 1, done: 1 } });
    expect(calls[0]).toMatchObject({ prompt: "coin pickup, bright chime", durationMs: 600 });
    expect(exported.files.map(file => path.relative(tempDir, file.path))).toEqual([
      path.join("out", "game", "coin-pickup.mp3")
    ]);
    const bytes = await readFile(path.join(tempDir, "out", "game", "coin-pickup.mp3"));
    expect(new Uint8Array(bytes)).toEqual(CHIME);
  });

  it("exposes app.sfx typed as SfxApi", async () => {
    const app = await startApp(tempDir, fakeHandler().handler);
    stops.push(() => app.stop());

    expectTypeOf(app.sfx).toEqualTypeOf<SfxApi>();
    expect(Object.keys(app.sfx).toSorted()).toEqual(["estimate", "generate", "providers"]);
  });
});
