import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreConfig, createCore, createPlugin } from "../../../../config";
import { registryPlugin } from "../../../registry";
import type { VideoHandler, VideoJobPoll } from "../../contract";
import { videoPlugin } from "../../index";

/**
 * Real app: registry + video + one fake provider registered in `onInit`.
 *
 * @param tempDir - Directory for the journal and store.
 * @param handler - The fake video handler.
 * @returns The created app.
 * @example
 * ```ts
 * const app = buildApp(tempDir, handler);
 * ```
 */
function buildApp(tempDir: string, handler: VideoHandler) {
  const fakeProvider = createPlugin("fakeVideoProvider", {
    depends: [registryPlugin, videoPlugin],
    onInit: ctx => {
      ctx.require(registryPlugin).register("video", "fake", handler);
    }
  });
  return createCore(coreConfig, {
    plugins: [registryPlugin, videoPlugin, fakeProvider],
    pluginConfigs: {
      journal: { path: path.join(tempDir, "journal.db") },
      store: { dir: path.join(tempDir, "store") },
      video: { defaultProvider: "fake", pollIntervalMs: 1 }
    }
  }).createApp();
}

const CLIP = new Uint8Array([0, 0, 0, 24]);

describe("video: through a real app", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "video-int-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs a submit + poll provider to the finished clip", async () => {
    let polls = 0;
    const handler: VideoHandler = {
      estimate: request => ({ usd: (request.seconds ?? 5) * 0.06 }),
      submit: async () => ({ jobId: "job-1" }),
      poll: async (): Promise<VideoJobPoll> => {
        polls += 1;
        return polls < 3
          ? { state: "pending" }
          : { state: "done", video: CLIP, mimeType: "video/mp4", costUsd: 0.3 };
      }
    };
    const app = buildApp(tempDir, handler);
    await app.start();

    const result = await app.video.generate({ model: "minimax-h3", prompt: "push-in" });

    expect(result).toEqual({ video: CLIP, mimeType: "video/mp4", costUsd: 0.3 });
    expect(polls).toBe(3);
    expect(app.video.estimate({ model: "minimax-h3", prompt: "x", seconds: 5 }).usd).toBeCloseTo(
      0.3
    );
    expect(app.video.providers()).toEqual(["fake"]);
    await app.stop();
  });

  it("uses execute when the provider has it, and throws a failed job's error", async () => {
    const app = buildApp(tempDir, {
      estimate: () => ({ usd: 0 }),
      execute: async () => ({ video: CLIP, mimeType: "video/mp4", costUsd: 0 })
    });
    await app.start();
    await expect(app.video.generate({ model: "m", prompt: "p" })).resolves.toMatchObject({
      mimeType: "video/mp4"
    });
    await app.stop();

    const failing = buildApp(tempDir, {
      estimate: () => ({ usd: 0 }),
      submit: async () => ({ jobId: "job-2" }),
      poll: async () => ({ state: "failed", error: new Error("generation_timeout") })
    });
    await failing.start();
    await expect(failing.video.generate({ model: "m", prompt: "p" })).rejects.toThrow(
      "generation_timeout"
    );
    await failing.stop();
  });
});
