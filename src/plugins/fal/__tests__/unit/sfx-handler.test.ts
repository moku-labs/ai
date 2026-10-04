import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { SfxHandler, SfxRequest } from "../../../sfx/contract";
import { TerminalProviderError } from "../../errors";
import { createSfxHandler } from "../../sfx/handler";
import {
  bytesResponse,
  callsOf,
  createFakeEnv,
  createTestCtx,
  jsonBodyOf,
  jsonResponse,
  stubFetch,
  submitResponse
} from "./fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// ("sfx", "fal"): estimate and execute over the generic queue, mp3 only.
// ─────────────────────────────────────────────────────────────────────────────

const MP3 = new Uint8Array([73, 68, 51, 4]);
const ENDPOINT = "fal-ai/elevenlabs/sound-effects/v2";
const REQUEST: SfxRequest = { prompt: "coin pickup", model: "elevenlabs-sfx-v2", durationMs: 600 };

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The submit, status, result and download responses of one finished sfx job. */
function finishedJob(audio: Record<string, unknown>, download: Response): Response[] {
  return [
    submitResponse("req-1"),
    jsonResponse(200, { status: "COMPLETED" }),
    jsonResponse(200, { audio }),
    download
  ];
}

/** The error `promise` rejects with. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

describe("estimate", () => {
  it("bills per started second without the key or the network", () => {
    const fetchMock = stubFetch();
    const handler = createSfxHandler(createTestCtx({ env: createFakeEnv({}) }));
    expect(handler.estimate(REQUEST)).toEqual({ usd: 0.002 });
    expect(handler.estimate({ ...REQUEST, durationMs: 2500 })).toEqual({ usd: 0.006 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bills the 22 s cap when the request has no duration", () => {
    const handler = createSfxHandler(createTestCtx());
    expect(handler.estimate({ prompt: "coin", model: "elevenlabs-sfx-v2" })).toEqual({
      usd: 0.044
    });
  });

  it("reads sfx: overrides from priceOverrides", () => {
    const ctx = createTestCtx({ config: { priceOverrides: { "sfx:elevenlabs-sfx-v2": 0.01 } } });
    expect(createSfxHandler(ctx).estimate(REQUEST)).toEqual({ usd: 0.01 });
  });

  it("refuses an invalid request as a terminal 400", () => {
    const handler = createSfxHandler(createTestCtx());
    expect(() => handler.estimate({ ...REQUEST, durationMs: 30_000 })).toThrow(
      TerminalProviderError
    );
  });
});

describe("execute", () => {
  it("queues the mp3 body, waits, downloads the audio and returns it with cost and meta", async () => {
    const fetchMock = stubFetch(
      ...finishedJob(
        { url: "https://v3.fal.media/files/coin.mp3", content_type: "audio/mpeg" },
        bytesResponse(MP3, "audio/mpeg")
      )
    );
    const ctx = createTestCtx();

    const result = await createSfxHandler(ctx).execute(
      { ...REQUEST, promptInfluence: 0.3, loop: false },
      {}
    );

    const [post] = callsOf(fetchMock);
    expect(post?.url).toBe(`https://queue.fal.run/${ENDPOINT}`);
    expect(post?.headers.Authorization).toBe("Key test-fal-key");
    expect(jsonBodyOf(post)).toEqual({
      text: "coin pickup",
      duration_seconds: 0.6,
      prompt_influence: 0.3,
      loop: false,
      output_format: "mp3_44100_128"
    });
    expect(result).toEqual({
      audio: MP3,
      mimeType: "audio/mpeg",
      costUsd: 0.002,
      meta: {
        model: "elevenlabs-sfx-v2",
        endpoint: ENDPOINT,
        requestId: "req-1",
        durationMs: 600
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(ctx.log.info).toHaveBeenCalledWith("fal:sfx:submitted", {
      model: "elevenlabs-sfx-v2",
      endpoint: ENDPOINT,
      requestId: "req-1",
      durationMs: 600
    });
    expect(ctx.log.info).toHaveBeenCalledWith("fal:sfx:done", { requestId: "req-1", bytes: 4 });
  });

  it("bills the 22 s cap and leaves durationMs out of meta when the request has no duration", async () => {
    stubFetch(
      ...finishedJob(
        { url: "https://v3.fal.media/files/coin.mp3", content_type: "audio/mpeg" },
        bytesResponse(MP3, "audio/mpeg")
      )
    );
    const result = await createSfxHandler(createTestCtx()).execute(
      { prompt: "coin", model: "elevenlabs-sfx-v2" },
      {}
    );
    expect(result.costUsd).toBe(0.044);
    expect(result.meta).toEqual({
      model: "elevenlabs-sfx-v2",
      endpoint: ENDPOINT,
      requestId: "req-1"
    });
  });

  it.each([
    [
      "the download header",
      { url: "https://v3.fal.media/files/coin" },
      bytesResponse(MP3, "audio/mpeg; charset=binary")
    ],
    ["the .mp3 extension", { url: "https://v3.fal.media/files/coin.mp3" }, new Response(MP3)],
    ["audio/mpeg", { url: "https://v3.fal.media/files/coin" }, new Response(MP3)],
    [
      "fal's audio/mp3",
      { url: "https://v3.fal.media/files/coin", content_type: "audio/mp3" },
      new Response(MP3)
    ]
  ])("accepts mp3 named by %s", async (_label, audio, download) => {
    stubFetch(...finishedJob(audio, download));
    const result = await createSfxHandler(createTestCtx()).execute(REQUEST, {});
    expect(result).toMatchObject({ audio: MP3, mimeType: "audio/mpeg" });
  });

  it.each([
    [
      "fal's content_type",
      { url: "https://v3.fal.media/files/coin.mp3", content_type: "audio/wav" },
      new Response(MP3),
      "audio/wav"
    ],
    [
      "the download header",
      { url: "https://v3.fal.media/files/coin" },
      bytesResponse(MP3, "audio/x-wav"),
      "audio/x-wav"
    ],
    [
      "the .wav extension",
      { url: "https://v3.fal.media/files/coin.wav" },
      new Response(MP3),
      "audio/wav"
    ]
  ])("never returns another format: %s", async (_label, audio, download, mime) => {
    stubFetch(...finishedJob(audio, download));
    const error = await rejectionOf(createSfxHandler(createTestCtx()).execute(REQUEST, {}));
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({
      status: 415,
      message: `[ai] fal returned "${mime}" for sfx model "elevenlabs-sfx-v2", not mp3 (audio/mpeg).\n  sfx output is mp3 only: run the item with provider elevenlabs.`
    });
  });

  it("throws a plain error for a result without audio.url", async () => {
    stubFetch(
      submitResponse("req-1"),
      jsonResponse(200, { status: "COMPLETED" }),
      jsonResponse(200, { audio: {} })
    );
    await expect(createSfxHandler(createTestCtx()).execute(REQUEST, {})).rejects.toThrow(
      "[ai] fal returned an incomplete sfx result.\n  Expected audio.url in the response."
    );
  });

  it("validates before it reads the key or calls fal", async () => {
    const fetchMock = stubFetch();
    const handler = createSfxHandler(createTestCtx({ env: createFakeEnv({}) }));
    await expect(handler.execute({ ...REQUEST, model: "x" }, {})).rejects.toBeInstanceOf(
      TerminalProviderError
    );
    await expect(handler.execute(REQUEST, {})).rejects.toThrow("[ai] FAL_KEY is not set.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not submit when the caller already aborted", async () => {
    const fetchMock = stubFetch();
    const controller = new AbortController();
    controller.abort(new Error("paused"));
    await expect(
      createSfxHandler(createTestCtx()).execute(REQUEST, { signal: controller.signal })
    ).rejects.toThrow("paused");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes the request log line without the prompt-bearing text field", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "moku-fal-sfx-"));
    const requestLog = path.join(dir, "fal.jsonl");
    try {
      stubFetch(
        ...finishedJob(
          { url: "https://v3.fal.media/files/coin.mp3", content_type: "audio/mpeg" },
          bytesResponse(MP3, "audio/mpeg")
        )
      );
      await createSfxHandler(createTestCtx({ config: { requestLog } })).execute(REQUEST, {});

      const line = JSON.parse(readFileSync(requestLog, "utf8").trim()) as Record<string, unknown>;
      expect(line).toMatchObject({
        task: "sfx",
        model: "elevenlabs-sfx-v2",
        endpoint: ENDPOINT,
        requestId: "req-1",
        prompt: "coin pickup",
        body: { duration_seconds: 0.6, output_format: "mp3_44100_128" }
      });
      expect(line.body).not.toHaveProperty("text");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("satisfies the sfx contract", () => {
    expectTypeOf(createSfxHandler(createTestCtx())).toEqualTypeOf<SfxHandler>();
  });
});
