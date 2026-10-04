import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvProvider } from "@moku-labs/common";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { imagePlugin } from "../../../image";
import type { ImageHandler } from "../../../image/contract";
import { musicPlugin } from "../../../music";
import type { MusicHandler } from "../../../music/contract";
import { promptGenPlugin } from "../../../promptGen";
import type { PromptGenHandler } from "../../../promptGen/contract";
import { registryPlugin } from "../../../registry";
import { sfxPlugin } from "../../../sfx";
import type { SfxHandler } from "../../../sfx/contract";
import { spritePlugin } from "../../../sprite";
import type { SpriteHandler } from "../../../sprite/contract";
import { videoPlugin } from "../../../video";
import type { VideoHandler } from "../../../video/contract";
import { createImageHandler } from "../../image/handler";
import { falPlugin } from "../../index";
import { createPromptGenHandler } from "../../llm/handler";
import { createMusicHandler } from "../../music/handler";
import { createSfxHandler } from "../../sfx/handler";
import { createSpriteHandler } from "../../sprite/handler";
import type { FalContext, FalModelInfo } from "../../types";
import { createVideoHandler } from "../../video/handler";

// ---------------------------------------------------------------------------
// Integration: one fal plugin registers six tasks in onInit; the image,
// prompt-gen, music, sfx and sprite facades drive them through a fake fal
// queue and a fake OpenRouter endpoint. fetch is stubbed at the boundary; no
// network. The sprite pixel step runs real sharp.
// ---------------------------------------------------------------------------

const PNG = new Uint8Array([137, 80, 78, 71]);
const MP3 = new Uint8Array([73, 68, 51, 4]);

/** A fixture env provider resolving FAL_KEY without touching process.env. */
const fixtureEnvProvider: EnvProvider = {
  name: "fal-tasks-fixture",
  load: () => ({ FAL_KEY: "integration-key" })
};

/** A real JSON response. */
function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

/** Queue responses of one job, from the submit POST to the download. */
function queueJob(requestId: string, result: unknown, download: Response): Response[] {
  return [
    json(200, {
      request_id: requestId,
      status_url: `https://queue.fal.run/x/requests/${requestId}/status`,
      response_url: `https://queue.fal.run/x/requests/${requestId}`
    }),
    json(200, { status: "IN_PROGRESS" }),
    json(200, { status: "COMPLETED" }),
    json(200, result),
    download
  ];
}

/** Stubs fetch with responses in order. */
function stubFetch(responses: Response[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  fetchMock.mockRejectedValue(new Error("unexpected extra fetch call"));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Assembles registry + the six task facades + fal, fal as their default provider. */
function buildFramework(dbPath: string, requestLog: string) {
  return createCore(coreConfig, {
    plugins: [
      registryPlugin,
      videoPlugin,
      imagePlugin,
      promptGenPlugin,
      musicPlugin,
      sfxPlugin,
      spritePlugin,
      falPlugin
    ],
    pluginConfigs: {
      journal: { path: dbPath },
      env: { providers: [fixtureEnvProvider] },
      image: { defaultProvider: "fal" },
      promptGen: { defaultProvider: "fal" },
      music: { defaultProvider: "fal" },
      sfx: { defaultProvider: "fal" },
      fal: { pollIntervalMs: 0, requestLog }
    }
  });
}

describe("fal six-task integration", () => {
  let tempDir: string;
  let dbPath: string;
  let requestLog: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "moku-fal-tasks-"));
    dbPath = path.join(tempDir, "journal.db");
    requestLog = path.join(tempDir, "log", "fal.jsonl");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("registers video, image, prompt-gen, music, sfx and sprite under fal in onInit", async () => {
    const app = buildFramework(dbPath, requestLog).createApp();
    await app.start();

    for (const task of ["video", "image", "prompt-gen", "music", "sfx", "sprite"]) {
      expect(app.registry.providers(task)).toContain("fal");
      expect(app.registry.resolve(task, "fal")).toBeTypeOf("object");
    }
    const image = app.registry.resolve("image", "fal");
    expect(image).toHaveProperty("submit");
    expect(image).toHaveProperty("poll");

    await app.stop();
  });

  it("lists models per task through app.fal.models, typed as FalModelInfo[]", async () => {
    const app = buildFramework(dbPath, requestLog).createApp();
    await app.start();

    const music = app.fal.models("music");
    expectTypeOf(music).toEqualTypeOf<FalModelInfo[]>();
    expect(music.map(model => model.id)).toEqual(["elevenlabs-music-v2.5", "stable-audio-2.5"]);
    expect(app.fal.models("sfx").map(model => model.id)).toEqual(["elevenlabs-sfx-v2"]);
    expect(app.fal.models("sprite").map(model => model.id)).toEqual(["birefnet", "none"]);

    await app.stop();
  });

  it("app.image.generate runs a fal queue job and writes the request log", async () => {
    const fetchMock = stubFetch(
      queueJob(
        "img-1",
        { images: [{ url: "https://v3.fal.media/files/o.png", width: 1440, height: 2560 }] },
        new Response(PNG, { status: 200, headers: { "content-type": "image/png" } })
      )
    );
    const app = buildFramework(dbPath, requestLog).createApp();
    await app.start();

    const result = await app.image.generate({ prompt: "patisserie", model: "seedream-4.5-edit" });

    expect(result).toMatchObject({ image: PNG, mimeType: "image/png", costUsd: 0.04 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://queue.fal.run/fal-ai/bytedance/seedream/v4.5/text-to-image"
    );
    const [line] = readFileSync(requestLog, "utf8").trim().split("\n");
    expect(JSON.parse(line ?? "{}")).toMatchObject({
      task: "image",
      model: "seedream-4.5-edit",
      requestId: "img-1",
      prompt: "patisserie",
      body: { image_size: { width: 1440, height: 2560 }, num_images: 1 }
    });

    await app.stop();
  });

  it("app.music.generate runs a fal queue job", async () => {
    stubFetch(
      queueJob(
        "mus-1",
        { audio: { url: "https://v3.fal.media/files/track.mp3" } },
        new Response(MP3, { status: 200 })
      )
    );
    const app = buildFramework(dbPath, requestLog).createApp();
    await app.start();

    const result = await app.music.generate({
      prompt: "tense synth",
      model: "stable-audio-2.5",
      lengthMs: 30_000
    });

    expect(result).toMatchObject({ audio: MP3, mimeType: "audio/mpeg", costUsd: 0.2 });

    await app.stop();
  });

  it("app.sfx.generate runs a fal queue job and returns mp3", async () => {
    const fetchMock = stubFetch(
      queueJob(
        "sfx-1",
        { audio: { url: "https://v3.fal.media/files/coin.mp3", content_type: "audio/mpeg" } },
        new Response(MP3, { status: 200 })
      )
    );
    const app = buildFramework(dbPath, requestLog).createApp();
    await app.start();

    const result = await app.sfx.generate({
      prompt: "coin pickup",
      model: "elevenlabs-sfx-v2",
      durationMs: 600
    });

    expect(result).toMatchObject({ audio: MP3, mimeType: "audio/mpeg", costUsd: 0.002 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://queue.fal.run/fal-ai/elevenlabs/sound-effects/v2"
    );

    await app.stop();
  });

  it("app.sprite.generate cuts a transparent source with none: no HTTP", async () => {
    const fetchMock = stubFetch([]);
    const png = await sharp({
      create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
    })
      .composite([
        {
          input: { create: { width: 4, height: 3, channels: 4, background: "#ffcc00" } },
          left: 8,
          top: 2
        }
      ])
      .png()
      .toBuffer();
    const sourcePath = path.join(tempDir, "icon.png");
    writeFileSync(sourcePath, png);
    const app = buildFramework(dbPath, requestLog).createApp();
    await app.start();

    const result = await app.sprite.generate({
      source: { path: sourcePath, mimeType: "image/png", hash: "icon" },
      model: "none"
    });

    expect(result).toMatchObject({ mimeType: "image/png", costUsd: 0 });
    expect(result.meta).toMatchObject({ model: "none", width: 4, height: 3 });
    expect(fetchMock).not.toHaveBeenCalled();

    await app.stop();
  });

  it("app.promptGen.generate answers through the fal router", async () => {
    const fetchMock = stubFetch([
      json(200, {
        id: "gen-1",
        choices: [{ message: { content: "five calm words here" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 5, cost: 0.0001 }
      })
    ]);
    const app = buildFramework(dbPath, requestLog).createApp();
    await app.start();

    const result = await app.promptGen.generate({ prompt: "Caption a sunset in five words." });

    expect(result.text).toBe("five calm words here");
    expect(result.costUsd).toBe(0.0001);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://fal.run/openrouter/router/openai/v1/chat/completions"
    );

    await app.stop();
  });

  it("each handler satisfies its task contract", () => {
    const app = buildFramework(dbPath, requestLog).createApp();
    expectTypeOf(createVideoHandler).returns.toMatchTypeOf<VideoHandler>();
    expectTypeOf(createImageHandler).returns.toMatchTypeOf<ImageHandler>();
    expectTypeOf(createPromptGenHandler).returns.toMatchTypeOf<PromptGenHandler>();
    expectTypeOf(createMusicHandler).returns.toMatchTypeOf<MusicHandler>();
    expectTypeOf(createSfxHandler).returns.toMatchTypeOf<SfxHandler>();
    expectTypeOf(createSpriteHandler).returns.toMatchTypeOf<SpriteHandler>();
    expectTypeOf(createImageHandler).parameter(0).toEqualTypeOf<FalContext>();
    // @ts-expect-error — "audio" is not a fal task
    expect(() => app.fal.models("audio")).toThrow('[ai] Unknown fal task "audio".');
  });
});
