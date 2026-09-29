import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { MusicHandler, MusicRequest } from "../../../music/contract";
import { encodeJobId } from "../../client/queue";
import { createMusicHandler } from "../../music/handler";
import { TerminalProviderError } from "../../types";
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
// ("music", "fal"): estimate, submit/poll, execute over the generic queue.
// ─────────────────────────────────────────────────────────────────────────────

const MP3 = new Uint8Array([73, 68, 51, 4]);
const REQUEST: MusicRequest = {
  prompt: "tense synth",
  model: "elevenlabs-music-v2.5",
  lengthMs: 65_000
};
const JOB_ID = encodeJobId({
  endpoint: "fal-ai/elevenlabs/music/v2.5",
  requestId: "req-1",
  statusUrl: "https://queue.fal.run/custom/requests/req-1/status-x",
  responseUrl: "https://queue.fal.run/custom/requests/req-1/result-x"
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The status + result + download responses of one finished music job. */
function finishedJob(audio: Record<string, unknown>, download: Response): Response[] {
  return [jsonResponse(200, { status: "COMPLETED" }), jsonResponse(200, { audio }), download];
}

describe("estimate", () => {
  it("bills ElevenLabs per started minute and Stable Audio per generation, without the key", () => {
    const fetchMock = stubFetch();
    const handler = createMusicHandler(createTestCtx({ env: createFakeEnv({}) }));
    expect(handler.estimate(REQUEST)).toEqual({ usd: 1.6 });
    expect(handler.estimate({ ...REQUEST, model: "stable-audio-2.5", lengthMs: 30_000 })).toEqual({
      usd: 0.2
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an invalid request as a terminal 400", () => {
    const handler = createMusicHandler(createTestCtx());
    expect(() => handler.estimate({ ...REQUEST, lengthMs: 700_000 })).toThrow(
      TerminalProviderError
    );
  });
});

describe("submit", () => {
  it("queues the model's body and logs fal:music:submitted", async () => {
    const fetchMock = stubFetch(submitResponse("req-1"));
    const ctx = createTestCtx();

    const { jobId } = await createMusicHandler(ctx).submit(REQUEST, {});

    const [post] = callsOf(fetchMock);
    expect(post?.url).toBe("https://queue.fal.run/fal-ai/elevenlabs/music/v2.5");
    expect(jsonBodyOf(post)).toEqual({
      prompt: "tense synth",
      music_length_ms: 65_000,
      force_instrumental: true,
      output_format: "mp3_48000_192"
    });
    expect(JSON.parse(jobId)).toMatchObject({ requestId: "req-1" });
    expect(ctx.log.info).toHaveBeenCalledWith("fal:music:submitted", {
      model: "elevenlabs-music-v2.5",
      endpoint: "fal-ai/elevenlabs/music/v2.5",
      requestId: "req-1",
      lengthMs: 65_000
    });
  });

  it("validates before it reads the key or calls fal", async () => {
    const fetchMock = stubFetch();
    const handler = createMusicHandler(createTestCtx({ env: createFakeEnv({}) }));
    await expect(handler.submit({ ...REQUEST, model: "suno" }, {})).rejects.toBeInstanceOf(
      TerminalProviderError
    );
    await expect(handler.submit(REQUEST, {})).rejects.toThrow("[ai] FAL_KEY is not set.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not submit when the caller already aborted", async () => {
    const fetchMock = stubFetch();
    const controller = new AbortController();
    controller.abort(new Error("paused"));
    await expect(
      createMusicHandler(createTestCtx()).submit(REQUEST, { signal: controller.signal })
    ).rejects.toThrow("paused");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("poll", () => {
  it("is pending while fal works", async () => {
    stubFetch(jsonResponse(200, { status: "IN_QUEUE" }));
    expect(await createMusicHandler(createTestCtx()).poll(JOB_ID, REQUEST, {})).toEqual({
      state: "pending"
    });
  });

  it("returns the audio with fal's content type, cost and meta", async () => {
    stubFetch(
      ...finishedJob(
        { url: "https://v3.fal.media/files/track.mp3", content_type: "audio/wav" },
        bytesResponse(MP3, "audio/mpeg")
      )
    );
    const ctx = createTestCtx();

    const poll = await createMusicHandler(ctx).poll(JOB_ID, REQUEST, {});

    expect(poll).toEqual({
      state: "done",
      audio: MP3,
      mimeType: "audio/wav",
      costUsd: 1.6,
      meta: {
        model: "elevenlabs-music-v2.5",
        endpoint: "fal-ai/elevenlabs/music/v2.5",
        requestId: "req-1",
        lengthMs: 65_000
      }
    });
    expect(ctx.log.info).toHaveBeenCalledWith("fal:music:done", { requestId: "req-1", bytes: 4 });
  });

  it.each([
    [
      "the download header",
      "https://v3.fal.media/files/track.mp3",
      bytesResponse(MP3, "audio/flac"),
      "audio/flac"
    ],
    ["the .ogg extension", "https://v3.fal.media/files/track.ogg", new Response(MP3), "audio/ogg"],
    [
      "the .opus extension",
      "https://v3.fal.media/files/track.opus",
      new Response(MP3),
      "audio/ogg"
    ],
    ["the .wav extension", "https://v3.fal.media/files/track.wav", new Response(MP3), "audio/wav"],
    ["audio/mpeg", "https://v3.fal.media/files/track", new Response(MP3), "audio/mpeg"]
  ])("falls back to %s for the MIME type", async (_label, url, download, mimeType) => {
    stubFetch(...finishedJob({ url }, download));
    const poll = await createMusicHandler(createTestCtx()).poll(JOB_ID, REQUEST, {});
    expect(poll).toMatchObject({ state: "done", mimeType });
  });

  it("fails a job fal finished with an error, logged as fal:music:failed", async () => {
    stubFetch(jsonResponse(200, { status: "COMPLETED", error: "odd", error_type: "x" }));
    const ctx = createTestCtx();
    const poll = await createMusicHandler(ctx).poll(JOB_ID, REQUEST, {});
    expect(poll.state).toBe("failed");
    expect(ctx.log.warn).toHaveBeenCalledWith(
      "fal:music:failed",
      expect.objectContaining({ requestId: "req-1" })
    );
  });

  it("throws a plain error for a result without audio.url", async () => {
    stubFetch(jsonResponse(200, { status: "COMPLETED" }), jsonResponse(200, { audio: {} }));
    await expect(createMusicHandler(createTestCtx()).poll(JOB_ID, REQUEST, {})).rejects.toThrow(
      "[ai] fal returned an incomplete music result.\n  Expected audio.url in the response."
    );
  });
});

describe("execute", () => {
  it("submits, waits in process and returns the audio", async () => {
    const fetchMock = stubFetch(
      submitResponse("req-1"),
      jsonResponse(200, { status: "IN_PROGRESS" }),
      ...finishedJob(
        { url: "https://v3.fal.media/files/track.mp3" },
        bytesResponse(MP3, "audio/mpeg")
      )
    );

    const result = await createMusicHandler(createTestCtx()).execute(REQUEST, {});

    expect(result).toMatchObject({ audio: MP3, mimeType: "audio/mpeg", costUsd: 1.6 });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("satisfies the music contract with every method", () => {
    expectTypeOf(createMusicHandler(createTestCtx())).toEqualTypeOf<Required<MusicHandler>>();
  });
});
