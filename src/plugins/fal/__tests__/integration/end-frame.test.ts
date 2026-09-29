import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvProvider } from "@moku-labs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreConfig, createCore, createPlugin } from "../../../../config";
import { buildfilePlugin } from "../../../buildfile";
import { registryPlugin } from "../../../registry";
import { runnerPlugin } from "../../../runner";
import { falPlugin } from "../../index";
import { callsOf, jsonBodyOf } from "../unit/fixtures";

// ---------------------------------------------------------------------------
// Integration: a build file whose video item takes a start and an end frame by
// `$ref`. The runner resolves both refs to stored files, fal uploads them as
// data URIs and POSTs both URLs. fetch is stubbed by URL; no real network.
// ---------------------------------------------------------------------------

const I2V_URL = "https://queue.fal.run/minimax/h3-max/image-to-video";
const STATUS_URL = "https://queue.fal.run/x/requests/req-1/status";
const RESULT_URL = "https://queue.fal.run/x/requests/req-1";
const VIDEO_URL = "https://v3.fal.media/clip.mp4";
const CLIP = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);

/** Build file: a start frame, an end frame, and one clip between them. */
const FRAMES_YAML = `version: 1
name: frames
items:
  - id: shot.start
    task: image
    provider: fake
    input: { prompt: "door closed" }
  - id: shot.end
    task: image
    provider: fake
    input: { prompt: "door open" }
  - id: shot.clip
    task: video
    provider: fal
    input:
      model: minimax-h3-max-i2v
      prompt: "she opens the door"
      image: { $ref: shot.start }
      endImage: { $ref: shot.end }
      seconds: 5
`;

/** A fixture env provider resolving FAL_KEY without touching process.env. */
const fixtureEnvProvider: EnvProvider = {
  name: "fal-end-frame-fixture",
  load: () => ({ FAL_KEY: "integration-key" })
};

/** The PNG-typed bytes the fake image provider returns for `prompt`. */
function pngOf(prompt: string): Uint8Array {
  return new TextEncoder().encode(`png:${prompt}`);
}

/** The data URI fal sends for the fake image of `prompt`. */
function dataUriOf(prompt: string): string {
  return `data:image/png;base64,${Buffer.from(pngOf(prompt)).toString("base64")}`;
}

/** A fake image provider: PNG-typed bytes derived from the prompt. */
const fakeImagePlugin = createPlugin("fakeImage", {
  depends: [registryPlugin],
  onInit: ctx => {
    ctx.require(registryPlugin).register("image", "fake", {
      estimate: () => ({ usd: 0 }),
      execute: async (request: { prompt: string }) => ({
        image: pngOf(request.prompt),
        mimeType: "image/png",
        costUsd: 0
      })
    });
  }
});

/** Stubs fetch by URL for one fal job: submit, status, result, clip download. */
function stubFalQueue(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === I2V_URL) {
      return Response.json({
        request_id: "req-1",
        status_url: STATUS_URL,
        response_url: RESULT_URL
      });
    }
    if (url === STATUS_URL) return Response.json({ status: "COMPLETED" });
    if (url === RESULT_URL) {
      return Response.json({ video: { url: VIDEO_URL, content_type: "video/mp4" } });
    }
    if (url === VIDEO_URL) return new Response(CLIP, { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fal end frame through the runner", () => {
  let tempDir: string;
  const stops: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-fal-end-frame-"));
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    await rm(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("a video item with image and endImage $refs reaches fal with both URLs", async () => {
    const fetchMock = stubFalQueue();
    const framework = createCore(coreConfig, {
      plugins: [registryPlugin, buildfilePlugin, runnerPlugin, fakeImagePlugin, falPlugin],
      pluginConfigs: {
        journal: { path: path.join(tempDir, "journal.db") },
        store: { dir: path.join(tempDir, "store") },
        env: { providers: [fixtureEnvProvider] },
        runner: { retryBaseMs: 1, pollIntervalMs: 1 },
        fal: { upload: "data-uri" }
      }
    });
    const app = framework.createApp();
    await app.start();
    stops.push(() => app.stop());
    await writeFile(path.join(tempDir, "frames.moku.yaml"), FRAMES_YAML);

    const result = await app.runner.run({ files: path.join(tempDir, "*.moku.yaml") });

    expect(result).toMatchObject({ status: "done", totals: { total: 3, done: 3 } });
    const posts = callsOf(fetchMock).filter(call => call.url === I2V_URL);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.method).toBe("POST");
    expect(jsonBodyOf(posts[0])).toEqual({
      prompt: "she opens the door",
      prompt_expansion_mode: "disabled",
      image_url: dataUriOf("door closed"),
      end_image_url: dataUriOf("door open"),
      duration: 5,
      resolution: "768P"
    });
  });
});
