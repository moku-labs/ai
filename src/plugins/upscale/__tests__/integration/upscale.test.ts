import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { coreConfig, createCore, createPlugin } from "../../../../config";
import { buildfilePlugin } from "../../../buildfile";
import { registryPlugin } from "../../../registry";
import { runnerPlugin } from "../../../runner";
import type { UpscaleEstimateRequest, UpscaleHandler, UpscaleRequest } from "../../contract";
import { upscalePlugin } from "../../index";
import type { UpscaleApi } from "../../types";

/** Bytes the fake provider returns as the upscaled video. */
const UPSCALED = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);

/**
 * A fake upscale handler pricing 0.06 USD per second that records what it saw.
 *
 * @returns The handler plus its estimate and execute logs.
 */
function fakeHandler(): {
  handler: UpscaleHandler;
  estimates: UpscaleEstimateRequest[];
  executed: UpscaleRequest[];
} {
  const estimates: UpscaleEstimateRequest[] = [];
  const executed: UpscaleRequest[] = [];
  return {
    estimates,
    executed,
    handler: {
      estimate: request => {
        estimates.push(request);
        return { usd: Math.round(request.seconds * 0.06 * 1e6) / 1e6 };
      },
      execute: async request => {
        executed.push(request);
        return {
          video: UPSCALED,
          mimeType: "video/mp4",
          costUsd: Math.round(request.seconds * 0.06 * 1e6) / 1e6
        };
      }
    }
  };
}

/**
 * Real app: registry + buildfile + runner + upscale + one fake provider registered
 * in `onInit`, core plugins pinned under `tempDir`.
 *
 * @param tempDir - Directory for the journal and store.
 * @param handler - The fake upscale handler.
 * @returns A started app.
 */
async function startApp(tempDir: string, handler: UpscaleHandler) {
  const fakeProvider = createPlugin("fakeUpscaleProvider", {
    depends: [registryPlugin, upscalePlugin],
    onInit: ctx => {
      ctx.require(registryPlugin).register("upscale", "fake", handler);
    }
  });
  const app = createCore(coreConfig, {
    plugins: [registryPlugin, buildfilePlugin, runnerPlugin, upscalePlugin, fakeProvider],
    pluginConfigs: {
      journal: { path: path.join(tempDir, "journal.db") },
      store: { dir: path.join(tempDir, "store") },
      runner: { retryBaseMs: 1, pollIntervalMs: 1 },
      upscale: { defaultProvider: "fake", pollIntervalMs: 1 }
    }
  }).createApp();
  await app.start();
  return app;
}

/** Build file: one upscale item over a local source video, routed to the fake provider. */
const UPSCALE_YAML = `version: 1
name: episode
items:
  - id: up
    task: upscale
    provider: fake
    input: { model: starlight-fast-2, video: { $file: clean.mp4 }, factor: 1.5, seconds: 62.4 }
`;

describe("upscale: through a real app", () => {
  let tempDir: string;
  const stops: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "upscale-int-"));
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  // Bug caught: the facade, estimate or provider list is not wired to the "upscale" registry task.
  it("generates, estimates and lists providers through app.upscale", async () => {
    const { handler, executed } = fakeHandler();
    const app = await startApp(tempDir, handler);
    stops.push(() => app.stop());
    const video = { path: "out/ep01.mp4", mimeType: "video/mp4", hash: "ab12" };

    const up = await app.upscale.generate({
      video,
      model: "starlight-fast-2",
      factor: 1.5,
      seconds: 62.4
    });

    expect(up).toEqual({ video: UPSCALED, mimeType: "video/mp4", costUsd: 3.744 });
    expect(executed[0]?.video).toEqual(video);
    expect(
      app.upscale.estimate({ video: { $ref: "clean" }, model: "proteus", factor: 1.5, seconds: 10 })
        .usd
    ).toBeCloseTo(0.6);
    expect(app.upscale.providers()).toEqual(["fake"]);
  });

  // Bug caught: the runner cannot run an upscale item, estimates it with a resolved video,
  // hands the provider an unresolved reference, or fails to store the returned bytes.
  it("runs a build item with video: { $file } and stores the returned video bytes", async () => {
    const { handler, estimates, executed } = fakeHandler();
    const app = await startApp(tempDir, handler);
    stops.push(() => app.stop());
    await writeFile(path.join(tempDir, "clean.mp4"), "source-video");
    await writeFile(path.join(tempDir, "episode.moku.yaml"), UPSCALE_YAML);
    const pattern = path.join(tempDir, "*.moku.yaml");

    const estimate = await app.runner.estimate({ files: pattern });
    const result = await app.runner.run({ files: pattern });
    const exported = await app.runner.export({ outDir: path.join(tempDir, "out") });

    expect(estimate.totalUsd).toBeCloseTo(3.744);
    expect(estimates[0]?.video).toEqual({ $file: "clean.mp4" });
    expect(result).toMatchObject({ status: "done", totals: { total: 1, done: 1 } });
    expect(executed[0]?.video).toMatchObject({
      path: path.join(tempDir, "clean.mp4"),
      mimeType: "video/mp4"
    });
    expect(executed[0]?.video.hash).not.toBe("");
    const stored = exported.files[0];
    expect(stored?.path.endsWith(".mp4")).toBe(true);
    expect(new Uint8Array(await readFile(stored?.path ?? ""))).toEqual(UPSCALED);
  });

  it("exposes app.upscale typed as UpscaleApi", async () => {
    const app = await startApp(tempDir, fakeHandler().handler);
    stops.push(() => app.stop());

    expectTypeOf(app.upscale).toEqualTypeOf<UpscaleApi>();
    expect(Object.keys(app.upscale).toSorted()).toEqual(["estimate", "generate", "providers"]);
  });
});
