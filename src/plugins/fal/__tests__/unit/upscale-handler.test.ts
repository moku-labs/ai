import { afterAll, afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { UpscaleHandler, UpscaleRequest } from "../../../upscale/contract";
import { encodeJobId } from "../../client/queue";
import { RetryableProviderError, TerminalProviderError } from "../../errors";
import { createUpscaleHandler } from "../../upscale/handler";
import {
  bytesResponse,
  callsOf,
  createFakeEnv,
  createTempFiles,
  createTestCtx,
  DEFAULT_CONFIG,
  initiateCount,
  jsonBodyOf,
  jsonResponse,
  okResponse,
  stubFetch,
  stubStorageFetch,
  submitResponse
} from "./fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// ("upscale", "fal"): estimate, submit/poll, execute over queue + storage + CDN.
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 1]);
const UPSCALED = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 2, 3]);
const ENDPOINT = "topaz/upscale/video/generative";
const QUEUE_POST = `https://queue.fal.run/${ENDPOINT}`;
const JOB_ID = encodeJobId({
  endpoint: ENDPOINT,
  requestId: "req-1",
  statusUrl: "https://queue.fal.run/custom/requests/req-1/status-x",
  responseUrl: "https://queue.fal.run/custom/requests/req-1/result-x"
});
/** Distinct from the 60 s default so a test can tell which limit a call ran under. */
const JOB_TIMEOUT_MS = 1_234_567;

const files = createTempFiles();
const SOURCE_FILE = files.file("clean.mp4", SOURCE, "video/mp4", "ab12");
const REQUEST: UpscaleRequest = {
  video: SOURCE_FILE,
  model: "starlight-fast-2",
  factor: 1.5,
  seconds: 62.4
};

afterAll(() => {
  files.cleanup();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The status + result + download responses of one finished upscale job. */
function finishedJob(video: Record<string, unknown>, download: Response): Response[] {
  return [jsonResponse(200, { status: "COMPLETED" }), jsonResponse(200, { video }), download];
}

describe("estimate", () => {
  it("prices an unresolved { $ref } video from the model rate, without the key or any I/O", () => {
    // Bug: estimate reads the key or the video file, so the plan fails before references resolve.
    const fetchMock = stubFetch();
    const handler = createUpscaleHandler(createTestCtx({ env: createFakeEnv({}) }));
    expect(handler.estimate({ ...REQUEST, video: { $ref: "clean" } })).toEqual({ usd: 3.744 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a factor out of range as a terminal 400", () => {
    const handler = createUpscaleHandler(createTestCtx());
    expect(() => handler.estimate({ ...REQUEST, factor: 4.1 })).toThrow(TerminalProviderError);
  });
});

describe("submit", () => {
  it("uploads the video once per content, then posts video_url and the fixed fields", async () => {
    // Bug: every submit of the same file uploads a minute of video again.
    const fetchMock = stubStorageFetch(submitResponse("req-1"), submitResponse("req-2"));
    const ctx = createTestCtx();
    const handler = createUpscaleHandler(ctx);

    const first = await handler.submit(REQUEST, {});
    await handler.submit(REQUEST, {});

    expect(initiateCount(fetchMock)).toBe(1);
    const posts = callsOf(fetchMock).filter(call => call.url === QUEUE_POST);
    expect(posts).toHaveLength(2);
    expect(jsonBodyOf(posts[0])).toEqual({
      model: "Starlight Fast 2",
      H264_output: true,
      upscale_factor: 1.5,
      video_url: expect.stringMatching(/^https:\/\/cdn\.fal\.test\/file\/[0-9a-f]{16}\.mp4$/)
    });
    expect(posts[0]?.headers.Authorization).toBe("Key test-fal-key");
    expect(JSON.parse(first.jobId)).toMatchObject({ requestId: "req-1" });
    expect(ctx.log.info).toHaveBeenCalledWith("fal:upscale:submitted", {
      model: "starlight-fast-2",
      endpoint: ENDPOINT,
      requestId: "req-1",
      seconds: 62.4,
      factor: 1.5
    });
  });

  it("uploads to storage even when config.upload is data-uri", async () => {
    // Bug: the video is inlined as a base64 data URI because the session mode says so.
    const fetchMock = stubStorageFetch(submitResponse("req-1"));
    await createUpscaleHandler(createTestCtx({ config: { upload: "data-uri" } })).submit(
      REQUEST,
      {}
    );
    expect(initiateCount(fetchMock)).toBe(1);
    const post = callsOf(fetchMock).find(call => call.url === QUEUE_POST);
    expect(jsonBodyOf(post).video_url).toMatch(/^https:\/\//);
  });

  it("fails the submit when the upload fails, with no data-URI fallback and no queue POST", async () => {
    // Bug: a failed upload falls back to a data URI of a minute of video and the job is posted anyway.
    const fetchMock = stubFetch(jsonResponse(503, { detail: "down" }));
    const handler = createUpscaleHandler(createTestCtx());
    await expect(handler.submit(REQUEST, {})).rejects.toBeInstanceOf(RetryableProviderError);
    expect(callsOf(fetchMock).map(call => call.url)).toEqual([DEFAULT_CONFIG.uploadUrl]);
  });

  it("validates and prices before it reads the key or uploads", async () => {
    // Bug: a bad request or a missing key is found only after the video was uploaded.
    const fetchMock = stubFetch();
    const handler = createUpscaleHandler(createTestCtx({ env: createFakeEnv({}) }));
    await expect(handler.submit({ ...REQUEST, model: "topaz" }, {})).rejects.toBeInstanceOf(
      TerminalProviderError
    );
    const image = { ...SOURCE_FILE, mimeType: "image/png" };
    await expect(handler.submit({ ...REQUEST, video: image }, {})).rejects.toThrow(
      "Invalid upscale request: video.mimeType "
    );
    await expect(handler.submit(REQUEST, {})).rejects.toThrow("[ai] FAL_KEY is not set.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts nothing when the caller aborts during the upload", async () => {
    // Bug: an abort that lands while the video uploads still queues, and bills, the job.
    const controller = new AbortController();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === DEFAULT_CONFIG.uploadUrl) {
        return jsonResponse(200, {
          upload_url: "https://upload.fal.test/put/1",
          file_url: "https://cdn.fal.test/file/1.mp4"
        });
      }
      controller.abort(new Error("paused"));
      return init?.method === "PUT" ? okResponse() : submitResponse("req-1");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createUpscaleHandler(createTestCtx()).submit(REQUEST, { signal: controller.signal })
    ).rejects.toThrow("paused");
    expect(callsOf(fetchMock).some(call => call.url === QUEUE_POST)).toBe(false);
  });

  it("runs the upload under jobTimeoutMs and the queue POST under timeoutMs", async () => {
    // Bug: a minute of 1080x1920 video is uploaded under the 60 s per-request limit and times out.
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    stubStorageFetch(submitResponse("req-1"));
    const ctx = createTestCtx({ config: { jobTimeoutMs: JOB_TIMEOUT_MS } });

    await createUpscaleHandler(ctx).submit(REQUEST, {});

    // initiate, PUT, queue POST.
    expect(timeoutSpy.mock.calls.map(([ms]) => ms)).toEqual([
      JOB_TIMEOUT_MS,
      JOB_TIMEOUT_MS,
      DEFAULT_CONFIG.timeoutMs
    ]);
    expect(ctx.config.timeoutMs).toBe(DEFAULT_CONFIG.timeoutMs);
  });
});

describe("poll", () => {
  it("is pending while fal works", async () => {
    stubFetch(jsonResponse(200, { status: "IN_QUEUE" }));
    expect(await createUpscaleHandler(createTestCtx()).poll(JOB_ID, REQUEST, {})).toEqual({
      state: "pending"
    });
  });

  it("returns the video with fal's content type, cost and meta, and logs fal:upscale:done", async () => {
    // Bug: the result carries another field than `video`, or cost and meta are not the plan's.
    stubFetch(
      ...finishedJob(
        { url: "https://v3.fal.media/files/out.mp4", content_type: "video/quicktime" },
        bytesResponse(UPSCALED, "video/mp4")
      )
    );
    const ctx = createTestCtx();

    const poll = await createUpscaleHandler(ctx).poll(JOB_ID, REQUEST, {});

    expect(poll).toEqual({
      state: "done",
      video: UPSCALED,
      mimeType: "video/quicktime",
      costUsd: 3.744,
      meta: {
        model: "starlight-fast-2",
        endpoint: ENDPOINT,
        requestId: "req-1",
        seconds: 62.4,
        factor: 1.5
      }
    });
    expect(ctx.log.info).toHaveBeenCalledWith("fal:upscale:done", {
      requestId: "req-1",
      bytes: UPSCALED.length
    });
  });

  it.each([
    [
      "the download header",
      "https://v3.fal.media/files/out.mp4",
      bytesResponse(UPSCALED, "video/x-matroska"),
      "video/x-matroska"
    ],
    [
      "the .mov extension",
      "https://v3.fal.media/files/out.mov",
      new Response(UPSCALED),
      "video/quicktime"
    ],
    [
      "the .webm extension",
      "https://v3.fal.media/files/out.webm",
      new Response(UPSCALED),
      "video/webm"
    ],
    ["video/mp4", "https://v3.fal.media/files/out", new Response(UPSCALED), "video/mp4"]
  ])("falls back to %s for the MIME type", async (_label, url, download, mimeType) => {
    // Bug: a .mov result is stored as video/mp4, or an unnamed one has no MIME type at all.
    stubFetch(...finishedJob({ url }, download));
    const poll = await createUpscaleHandler(createTestCtx()).poll(JOB_ID, REQUEST, {});
    expect(poll).toMatchObject({ state: "done", mimeType });
  });

  it("downloads the result under jobTimeoutMs, the status and result calls under timeoutMs", async () => {
    // Bug: the result video is downloaded under the 60 s limit and a long clip never arrives.
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    stubFetch(
      ...finishedJob(
        { url: "https://v3.fal.media/files/out.mp4" },
        bytesResponse(UPSCALED, "video/mp4")
      )
    );
    const ctx = createTestCtx({ config: { jobTimeoutMs: JOB_TIMEOUT_MS } });

    await createUpscaleHandler(ctx).poll(JOB_ID, REQUEST, {});

    // status, result, download.
    expect(timeoutSpy.mock.calls.map(([ms]) => ms)).toEqual([
      DEFAULT_CONFIG.timeoutMs,
      DEFAULT_CONFIG.timeoutMs,
      JOB_TIMEOUT_MS
    ]);
  });

  it("throws the pinned plain error for a result without video.url", async () => {
    stubFetch(jsonResponse(200, { status: "COMPLETED" }), jsonResponse(200, { video: {} }));
    await expect(createUpscaleHandler(createTestCtx()).poll(JOB_ID, REQUEST, {})).rejects.toThrow(
      "[ai] fal returned an incomplete upscale result.\n  Expected video.url in the response."
    );
  });

  it("fails a job fal finished with an error, logged as fal:upscale:failed", async () => {
    // Bug: a failed job is reported pending forever, or its failure is not logged under the upscale event.
    stubFetch(jsonResponse(200, { status: "COMPLETED", error: "odd", error_type: "x" }));
    const ctx = createTestCtx();
    const poll = await createUpscaleHandler(ctx).poll(JOB_ID, REQUEST, {});
    expect(poll.state).toBe("failed");
    expect(ctx.log.warn).toHaveBeenCalledWith(
      "fal:upscale:failed",
      expect.objectContaining({ requestId: "req-1" })
    );
  });
});

describe("execute", () => {
  it("uploads, submits, waits in process and returns the video", async () => {
    const fetchMock = stubStorageFetch(
      submitResponse("req-1"),
      jsonResponse(200, { status: "IN_PROGRESS" }),
      ...finishedJob(
        { url: "https://v3.fal.media/files/out.mp4" },
        bytesResponse(UPSCALED, "video/mp4")
      )
    );

    const result = await createUpscaleHandler(createTestCtx()).execute(REQUEST, {});

    expect(result).toMatchObject({ video: UPSCALED, mimeType: "video/mp4", costUsd: 3.744 });
    // initiate, PUT, POST, 2 status reads, result, download.
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("satisfies the upscale contract with every method", () => {
    expectTypeOf(createUpscaleHandler(createTestCtx())).toEqualTypeOf<Required<UpscaleHandler>>();
  });
});
