import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvProvider } from "@moku-labs/common";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { registryPlugin } from "../../../registry";
import { videoPlugin } from "../../../video";
import type { VideoFile, VideoHandler } from "../../../video/contract";
import { falPlugin } from "../../index";
import type { FalContext, FalInfo } from "../../types";
import { FlaggedProviderError } from "../../types";
import { createVideoHandler } from "../../video/handler";

// ---------------------------------------------------------------------------
// Integration: fal registered in onInit through the real createApp lifecycle,
// consumed through the video facade. fetch is stubbed at the boundary; no
// real network calls anywhere in this suite.
// ---------------------------------------------------------------------------

const CLIP = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);

/** A fixture env provider resolving FAL_KEY without touching process.env. */
const fixtureEnvProvider: EnvProvider = {
  name: "fal-integration-fixture",
  load: () => ({ FAL_KEY: "integration-key" })
};

/** A real JSON response. */
function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

/** fal queue responses for one full job, in call order after the submit POST. */
function jobResponses(requestId: string): Response[] {
  return [
    json(200, {
      request_id: requestId,
      status_url: `https://queue.fal.run/x/requests/${requestId}/status`,
      response_url: `https://queue.fal.run/x/requests/${requestId}`
    }),
    json(202, { status: "IN_QUEUE" }),
    json(200, { status: "COMPLETED" }),
    json(200, { video: { url: "https://v3.fal.media/clip.mp4", content_type: "video/mp4" } }),
    new Response(CLIP, { status: 200 })
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

/** Assembles registry + video + fal with the journal and env pinned to fixtures. */
function buildFramework(dbPath: string) {
  return createCore(coreConfig, {
    plugins: [registryPlugin, videoPlugin, falPlugin],
    pluginConfigs: {
      journal: { path: dbPath },
      env: { providers: [fixtureEnvProvider] }
    }
  });
}

describe("fal integration", () => {
  let tempDir: string;
  let dbPath: string;
  let image: VideoFile;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "moku-fal-integration-"));
    dbPath = path.join(tempDir, "journal.db");
    const imagePath = path.join(tempDir, "key.png");
    writeFileSync(imagePath, new Uint8Array([1, 2, 3]));
    image = { path: imagePath, mimeType: "image/png", hash: "c".repeat(64) };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("registers under the video task in onInit", async () => {
    const app = buildFramework(dbPath).createApp();
    await app.start();

    expect(app.video.providers()).toEqual(["fal"]);
    expect(app.fal.info()).toEqual({
      provider: "fal",
      configured: true,
      models: [
        "seedance-2.5",
        "seedance-2.5-ref",
        "minimax-h3",
        "minimax-h3-max-ref",
        "kling-3-pro",
        "kling-o3-ref",
        "seedance-2.0-mini",
        "seedance-2.0-mini-ref",
        "seedance-2.0-ref",
        "wan-3.0-ref",
        "veo-3.1-fast",
        "vidu-q3",
        "vidu-q3-ref"
      ]
    });

    await app.stop();
  });

  it("app.video.estimate() uses fal's price table (spec example: minimax-h3 5 s = $0.30)", async () => {
    const app = buildFramework(dbPath).createApp();
    await app.start();

    expect(
      app.video.estimate(
        { model: "minimax-h3", prompt: "push-in", seconds: 5 },
        { provider: "fal" }
      )
    ).toEqual({ usd: 0.3 });

    await app.stop();
  });

  it("generates a clip end-to-end through app.video.generate()", async () => {
    const fetchMock = stubFetch(jobResponses("req-9"));
    const app = buildFramework(dbPath).createApp({
      pluginConfigs: { fal: { upload: "data-uri" }, video: { pollIntervalMs: 0 } }
    });
    await app.start();

    const result = await app.video.generate({ model: "minimax-h3", prompt: "push-in", image });

    expect(result).toEqual({
      video: CLIP,
      mimeType: "video/mp4",
      costUsd: 0.3,
      meta: { endpoint: "minimax/h3/image-to-video", requestId: "req-9", seconds: 5 }
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);

    await app.stop();
  });

  it("a job id survives a restart: a fresh app polls it to done with no second submit", async () => {
    const fetchMock = stubFetch(jobResponses("req-7"));
    const first = buildFramework(dbPath).createApp({
      pluginConfigs: { fal: { upload: "data-uri" } }
    });
    await first.start();
    const handler = first.registry.resolve("video", "fal") as VideoHandler;
    const request = { model: "minimax-h3", prompt: "push-in", image };

    const { jobId } = (await handler.submit?.(request, {})) ?? { jobId: "" };
    expect(await handler.poll?.(jobId, request, {})).toEqual({ state: "pending" });
    await first.stop();

    const second = buildFramework(dbPath).createApp();
    await second.start();
    const resumed = second.registry.resolve("video", "fal") as VideoHandler;
    const done = await resumed.poll?.(jobId, request, {});

    expect(done?.state).toBe("done");
    const submits = fetchMock.mock.calls.filter(
      call => (call[1] as RequestInit | undefined)?.method === "POST"
    );
    expect(submits).toHaveLength(1);

    await second.stop();
  });

  it("a content-policy failure surfaces as FlaggedProviderError through the facade", async () => {
    stubFetch([
      jobResponses("req-5")[0] as Response,
      json(200, { status: "COMPLETED", error: "blocked", error_type: "content_policy_violation" })
    ]);
    const app = buildFramework(dbPath).createApp({
      pluginConfigs: { fal: { upload: "data-uri" }, video: { pollIntervalMs: 0 } }
    });
    await app.start();

    await expect(
      app.video.generate({ model: "minimax-h3", prompt: "push-in", image })
    ).rejects.toBeInstanceOf(FlaggedProviderError);

    await app.stop();
  });

  describe("types", () => {
    it("createVideoHandler returns the async VideoHandler form for a FalContext", () => {
      expectTypeOf(createVideoHandler).parameter(0).toEqualTypeOf<FalContext>();
      expectTypeOf(createVideoHandler).returns.toMatchTypeOf<VideoHandler>();
      expectTypeOf(createVideoHandler).returns.toEqualTypeOf<
        Required<Pick<VideoHandler, "estimate" | "submit" | "poll">>
      >();
    });

    it("app.fal.info() is typed", () => {
      const app = buildFramework(dbPath).createApp();
      expectTypeOf(app.fal.info).returns.toEqualTypeOf<FalInfo>();
    });
  });
});
