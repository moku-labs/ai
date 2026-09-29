import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { coreConfig, createCore, createPlugin } from "../../../../config";
import { registryPlugin } from "../../../registry";
import type { MusicHandler, MusicJobPoll } from "../../contract";
import { musicPlugin } from "../../index";
import type { MusicApi } from "../../types";

/**
 * Real app: registry + music + one fake provider registered in `onInit`.
 *
 * @param tempDir - Directory for the journal and store.
 * @param handler - The fake music handler.
 * @returns The created app.
 */
function buildApp(tempDir: string, handler: MusicHandler) {
  const fakeProvider = createPlugin("fakeMusicProvider", {
    depends: [registryPlugin, musicPlugin],
    onInit: ctx => {
      ctx.require(registryPlugin).register("music", "fake", handler);
    }
  });
  return createCore(coreConfig, {
    plugins: [registryPlugin, musicPlugin, fakeProvider],
    pluginConfigs: {
      journal: { path: path.join(tempDir, "journal.db") },
      store: { dir: path.join(tempDir, "store") },
      music: { defaultProvider: "fake", pollIntervalMs: 1 }
    }
  }).createApp();
}

const TRACK = new Uint8Array([73, 68, 51, 4]);

describe("music: through a real app", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "music-int-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs a submit + poll provider to the finished track", async () => {
    let polls = 0;
    const handler: MusicHandler = {
      estimate: request => ({ usd: Math.ceil(request.lengthMs / 60_000) * 0.8 }),
      submit: async () => ({ jobId: "job-1" }),
      poll: async (): Promise<MusicJobPoll> => {
        polls += 1;
        return polls < 3
          ? { state: "pending" }
          : { state: "done", audio: TRACK, mimeType: "audio/mpeg", costUsd: 0.8 };
      }
    };
    const app = buildApp(tempDir, handler);
    await app.start();

    const result = await app.music.generate({
      prompt: "tense synth pulse",
      model: "elevenlabs-music-v2.5",
      lengthMs: 60_000
    });

    expect(result).toEqual({ audio: TRACK, mimeType: "audio/mpeg", costUsd: 0.8 });
    expect(polls).toBe(3);
    expect(
      app.music.estimate({ prompt: "x", model: "elevenlabs-music-v2.5", lengthMs: 90_000 }).usd
    ).toBeCloseTo(1.6);
    expect(app.music.providers()).toEqual(["fake"]);
    await app.stop();
  });

  it("uses execute when the provider has it, and throws a failed job's error", async () => {
    const app = buildApp(tempDir, {
      estimate: () => ({ usd: 0 }),
      execute: async () => ({ audio: TRACK, mimeType: "audio/mpeg", costUsd: 0 })
    });
    await app.start();
    await expect(
      app.music.generate({ prompt: "p", model: "m", lengthMs: 30_000 })
    ).resolves.toMatchObject({ mimeType: "audio/mpeg" });
    await app.stop();

    const failing = buildApp(tempDir, {
      estimate: () => ({ usd: 0 }),
      submit: async () => ({ jobId: "job-2" }),
      poll: async () => ({ state: "failed", error: new Error("generation_timeout") })
    });
    await failing.start();
    await expect(
      failing.music.generate({ prompt: "p", model: "m", lengthMs: 30_000 })
    ).rejects.toThrow("generation_timeout");
    await failing.stop();
  });

  it("throws the two-line unknown-provider error for an unregistered provider", async () => {
    const app = buildApp(tempDir, {
      estimate: () => ({ usd: 0 }),
      execute: async () => ({ audio: TRACK, mimeType: "audio/mpeg", costUsd: 0 })
    });
    await app.start();

    expect(() =>
      app.music.estimate({ prompt: "p", model: "m", lengthMs: 1000 }, { provider: "acme" })
    ).toThrow('[ai] No music provider named "acme" is registered.\n  Available: fake.');
    await app.stop();
  });

  it("exposes app.music typed as MusicApi", () => {
    const app = buildApp(tempDir, {
      estimate: () => ({ usd: 0 }),
      execute: async () => ({ audio: TRACK, mimeType: "audio/mpeg", costUsd: 0 })
    });

    expectTypeOf(app.music).toEqualTypeOf<MusicApi>();
    expect(Object.keys(app.music).toSorted()).toEqual(["estimate", "generate", "providers"]);
  });
});
