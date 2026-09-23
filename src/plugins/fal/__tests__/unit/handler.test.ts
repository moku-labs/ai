import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { VideoFile, VideoJobPoll, VideoRequest } from "../../../video/contract";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "../../types";
import { createVideoHandler } from "../../video/handler";
import type { TempFiles } from "./fixtures";
import {
  bytesResponse,
  callsOf,
  createFakeEnv,
  createTempFiles,
  createTestCtx,
  initiateResponse,
  jsonBodyOf,
  jsonResponse,
  okResponse,
  stubFetch,
  submitResponse,
  TEST_KEY
} from "./fixtures";

const PROMPT = "a secret prompt that must never be logged";
const STATUS_URL = "https://queue.fal.run/custom/requests/req-1/status-x";
const RESULT_URL = "https://queue.fal.run/custom/requests/req-1/result-x";
const VIDEO_URL = "https://v3.fal.media/files/clip.mp4";
const CLIP = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);

const JOB_ID = JSON.stringify({
  endpoint: "minimax/h3/image-to-video",
  requestId: "req-1",
  statusUrl: STATUS_URL,
  responseUrl: RESULT_URL
});

let temp: TempFiles;
let image: VideoFile;
let refs: VideoFile[];

beforeAll(() => {
  temp = createTempFiles();
  image = temp.file("key.png", new Uint8Array([1, 2, 3]), "image/png", "1".repeat(64));
  refs = [2, 3, 4, 5, 6].map(n =>
    temp.file(`ref${n}.png`, new Uint8Array([n]), "image/png", String(n).repeat(64))
  );
});

afterAll(() => {
  temp.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A minimax request with a keyframe. */
function minimaxRequest(overrides: Partial<VideoRequest> = {}): VideoRequest {
  return { model: "minimax-h3", prompt: PROMPT, image, ...overrides };
}

/** Everything any log call received, stringified. */
function loggedText(ctx: ReturnType<typeof createTestCtx>): string {
  const log = ctx.log as unknown as Record<string, ReturnType<typeof vi.fn>>;
  return JSON.stringify(
    ["info", "debug", "warn", "error"].flatMap(level => log[level]?.mock.calls ?? [])
  );
}

/** Asserts a poll result is `failed` and returns its error. */
function failedError(result: VideoJobPoll): unknown {
  if (result.state !== "failed") throw new Error(`expected failed, got ${result.state}`);
  return result.error;
}

describe("estimate", () => {
  it("is seconds x price for the alias, without any network call", () => {
    const fetchMock = stubFetch();
    const handler = createVideoHandler(createTestCtx());

    expect(handler.estimate({ model: "minimax-h3", prompt: "p" }).usd).toBe(0.3);
    expect(handler.estimate({ model: "kling-3-pro", prompt: "p", seconds: 10 }).usd).toBe(1.12);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws for an unknown model", () => {
    const handler = createVideoHandler(createTestCtx());
    expect(() => handler.estimate({ model: "nope", prompt: "p" })).toThrow(
      '[ai] Unknown fal video model "nope".'
    );
  });
});

describe("submit", () => {
  it("uploads the keyframe, POSTs the mapped body, and returns a JSON job id", async () => {
    const fetchMock = stubFetch(initiateResponse(1), okResponse(), submitResponse("req-1"));
    const handler = createVideoHandler(createTestCtx());

    const { jobId } = await handler.submit(minimaxRequest({ seconds: 6 }), {});

    expect(JSON.parse(jobId)).toEqual({
      endpoint: "minimax/h3/image-to-video",
      requestId: "req-1",
      statusUrl: STATUS_URL,
      responseUrl: RESULT_URL
    });
    const calls = callsOf(fetchMock);
    const submitCall = calls[2];
    expect(submitCall?.url).toBe("https://queue.fal.run/minimax/h3/image-to-video");
    expect(submitCall?.method).toBe("POST");
    expect(submitCall?.headers.Authorization).toBe(`Key ${TEST_KEY}`);
    expect(jsonBodyOf(submitCall)).toEqual({
      prompt: PROMPT,
      image_url: "https://cdn.fal.test/file/1",
      duration: 6,
      resolution: "768P"
    });
  });

  it("uploads image + refs for a reference model and merges params last", async () => {
    const fetchMock = stubFetch(
      initiateResponse(1),
      okResponse(),
      initiateResponse(2),
      okResponse(),
      initiateResponse(3),
      okResponse(),
      submitResponse()
    );
    const handler = createVideoHandler(createTestCtx());

    await handler.submit(
      {
        model: "seedance-2.5-ref",
        prompt: PROMPT,
        image,
        refs: refs.slice(0, 2),
        params: { resolution: "480p" }
      },
      {}
    );

    const body = jsonBodyOf(callsOf(fetchMock)[6]);
    expect(body.image_urls).toEqual([
      "https://cdn.fal.test/file/1",
      "https://cdn.fal.test/file/2",
      "https://cdn.fal.test/file/3"
    ]);
    expect(body.resolution).toBe("480p");
    expect(body.aspect_ratio).toBe("9:16");
  });

  it("does not upload refs for a model without a refs field", async () => {
    const fetchMock = stubFetch(initiateResponse(1), okResponse(), submitResponse());
    const handler = createVideoHandler(createTestCtx());

    await handler.submit({ model: "seedance-2.5", prompt: PROMPT, image, refs }, {});

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("sends at most 4 refs to kling-o3-ref and warns about the rest", async () => {
    const fetchMock = stubFetch(submitResponse());
    const ctx = createTestCtx({ config: { upload: "data-uri" } });
    const handler = createVideoHandler(ctx);

    await handler.submit({ model: "kling-o3-ref", prompt: PROMPT, image, refs }, {});

    const body = jsonBodyOf(callsOf(fetchMock)[0]);
    expect(body.image_urls).toHaveLength(4);
    expect(String(body.start_image_url)).toMatch(/^data:image\/png;base64,/);
    expect(ctx.log.warn).toHaveBeenCalledWith("fal:refs:truncated", {
      model: "kling-o3-ref",
      given: 5,
      max: 4
    });
  });

  it("throws a plain two-line Error when the key is missing, before any fetch", async () => {
    const fetchMock = stubFetch();
    const handler = createVideoHandler(createTestCtx({ env: createFakeEnv({}) }));

    const rejection = await handler.submit(minimaxRequest(), {}).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBeInstanceOf(RetryableProviderError);
    expect((rejection as Error).message).toBe(
      "[ai] FAL_KEY is not set.\n  Export it, or set fal.apiKeyEnv to the variable that holds your key."
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a plain Error when the model needs an image and none is given", async () => {
    const fetchMock = stubFetch();
    const handler = createVideoHandler(createTestCtx());

    await expect(handler.submit({ model: "kling-3-pro", prompt: PROMPT }, {})).rejects.toThrow(
      '[ai] fal model "kling-3-pro" needs an image.\n  Set input.image to a $ref or $file.'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown model", async () => {
    stubFetch();
    const handler = createVideoHandler(createTestCtx());
    await expect(handler.submit(minimaxRequest({ model: "veo" }), {})).rejects.toThrow(
      'Unknown fal video model "veo"'
    );
  });

  it("throws the classified error when the submit POST fails", async () => {
    stubFetch(initiateResponse(1), okResponse(), jsonResponse(503, {}));
    const handler = createVideoHandler(createTestCtx());
    await expect(handler.submit(minimaxRequest(), {})).rejects.toBeInstanceOf(
      RetryableProviderError
    );
  });

  it("throws a plain Error when the submit response lacks the queue URLs", async () => {
    stubFetch(initiateResponse(1), okResponse(), jsonResponse(200, { request_id: "r" }));
    const handler = createVideoHandler(createTestCtx());
    await expect(handler.submit(minimaxRequest(), {})).rejects.toThrow(
      /^\[ai\] fal returned an incomplete submit response\./
    );
  });

  it("never logs the prompt or the key", async () => {
    stubFetch(initiateResponse(1), okResponse(), submitResponse());
    const ctx = createTestCtx();
    await createVideoHandler(ctx).submit(minimaxRequest(), {});
    const logged = loggedText(ctx);
    expect(logged).not.toContain(PROMPT);
    expect(logged).not.toContain(TEST_KEY);
  });
});

describe("poll", () => {
  it("IN_QUEUE and IN_PROGRESS are pending; the status URL is used verbatim", async () => {
    const fetchMock = stubFetch(
      jsonResponse(202, { status: "IN_QUEUE", queue_position: 3 }),
      jsonResponse(202, { status: "IN_PROGRESS" })
    );
    const handler = createVideoHandler(createTestCtx());

    expect(await handler.poll(JOB_ID, minimaxRequest(), {})).toEqual({ state: "pending" });
    expect(await handler.poll(JOB_ID, minimaxRequest(), {})).toEqual({ state: "pending" });
    const [first] = callsOf(fetchMock);
    expect(first?.url).toBe(STATUS_URL);
    expect(first?.method).toBe("GET");
    expect(first?.headers.Authorization).toBe(`Key ${TEST_KEY}`);
  });

  it("an unknown status stays pending and is logged", async () => {
    stubFetch(jsonResponse(200, { status: "WARMING_UP" }));
    const ctx = createTestCtx();

    expect(await createVideoHandler(ctx).poll(JOB_ID, minimaxRequest(), {})).toEqual({
      state: "pending"
    });
    expect(ctx.log.warn).toHaveBeenCalledWith("fal:poll:unknown-status", {
      requestId: "req-1",
      status: "WARMING_UP"
    });
  });

  it("COMPLETED fetches the result, downloads the clip, and returns done", async () => {
    const fetchMock = stubFetch(
      jsonResponse(200, { status: "COMPLETED" }),
      jsonResponse(200, { video: { url: VIDEO_URL, content_type: "video/webm" } }),
      bytesResponse(CLIP)
    );
    const handler = createVideoHandler(createTestCtx());

    const result = await handler.poll(JOB_ID, minimaxRequest({ seconds: 10 }), {});

    expect(result).toEqual({
      state: "done",
      video: CLIP,
      mimeType: "video/webm",
      costUsd: 0.6,
      meta: { endpoint: "minimax/h3/image-to-video", requestId: "req-1", seconds: 10 }
    });
    const calls = callsOf(fetchMock);
    expect(calls[1]?.url).toBe(RESULT_URL);
    expect(calls[1]?.headers.Authorization).toBe(`Key ${TEST_KEY}`);
    expect(calls[2]?.url).toBe(VIDEO_URL);
    expect(calls[2]?.headers.Authorization).toBeUndefined();
  });

  it("defaults the mime type to video/mp4 and seconds to 5", async () => {
    stubFetch(
      jsonResponse(200, { status: "COMPLETED" }),
      jsonResponse(200, { video: { url: VIDEO_URL } }),
      bytesResponse(CLIP)
    );
    const result = await createVideoHandler(createTestCtx()).poll(JOB_ID, minimaxRequest(), {});
    expect(result.state === "done" && result.mimeType).toBe("video/mp4");
    expect(result.state === "done" && result.meta?.seconds).toBe(5);
  });

  it.each([
    "generation_timeout",
    "downstream_service_unavailable",
    "internal_server_error"
  ])("COMPLETED + error_type %s fails retryable (status 503)", async errorType => {
    stubFetch(
      jsonResponse(200, { status: "COMPLETED", error: "try again", error_type: errorType })
    );
    const error = failedError(
      await createVideoHandler(createTestCtx()).poll(JOB_ID, minimaxRequest(), {})
    );
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect((error as RetryableProviderError).status).toBe(503);
  });

  it("COMPLETED + a content_policy error_type fails flagged", async () => {
    stubFetch(
      jsonResponse(200, {
        status: "COMPLETED",
        error: "rejected",
        error_type: "content_policy_violation"
      })
    );
    const error = failedError(
      await createVideoHandler(createTestCtx()).poll(JOB_ID, minimaxRequest(), {})
    );
    expect(error).toBeInstanceOf(FlaggedProviderError);
  });

  it("COMPLETED + an error message mentioning content_policy fails flagged", async () => {
    stubFetch(jsonResponse(200, { status: "COMPLETED", error: "content_policy_violation: nsfw" }));
    const error = failedError(
      await createVideoHandler(createTestCtx()).poll(JOB_ID, minimaxRequest(), {})
    );
    expect(error).toBeInstanceOf(FlaggedProviderError);
  });

  it("COMPLETED + any other error fails terminal (400) with fal's text, truncated", async () => {
    stubFetch(
      jsonResponse(200, {
        status: "COMPLETED",
        error: `bad image ${"y".repeat(600)}`,
        error_type: "image_load_error"
      })
    );
    const error = failedError(
      await createVideoHandler(createTestCtx()).poll(JOB_ID, minimaxRequest(), {})
    ) as TerminalProviderError;
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error.status).toBe(400);
    expect(error.message).toContain("bad image");
    expect(error.message).not.toContain("y".repeat(300));
  });

  it("an object-shaped error is read through its message", async () => {
    stubFetch(jsonResponse(200, { status: "COMPLETED", error: { message: "odd failure" } }));
    const error = failedError(
      await createVideoHandler(createTestCtx()).poll(JOB_ID, minimaxRequest(), {})
    ) as TerminalProviderError;
    expect(error.message).toContain("odd failure");
  });

  it("a 422 content-policy result fails flagged", async () => {
    stubFetch(
      jsonResponse(200, { status: "COMPLETED" }),
      jsonResponse(422, { detail: [{ msg: "flagged", type: "content_policy_violation" }] })
    );
    const error = failedError(
      await createVideoHandler(createTestCtx()).poll(JOB_ID, minimaxRequest(), {})
    );
    expect(error).toBeInstanceOf(FlaggedProviderError);
  });

  it("a 4xx result fails terminal", async () => {
    stubFetch(jsonResponse(200, { status: "COMPLETED" }), jsonResponse(404, { detail: "gone" }));
    const error = failedError(
      await createVideoHandler(createTestCtx()).poll(JOB_ID, minimaxRequest(), {})
    );
    expect(error).toBeInstanceOf(TerminalProviderError);
  });

  it("a 5xx result is thrown so the runner keeps polling", async () => {
    stubFetch(jsonResponse(200, { status: "COMPLETED" }), jsonResponse(502, {}));
    await expect(
      createVideoHandler(createTestCtx()).poll(JOB_ID, minimaxRequest(), {})
    ).rejects.toBeInstanceOf(RetryableProviderError);
  });

  it("a network failure on the status call is thrown retryable", async () => {
    stubFetch(new TypeError("fetch failed"));
    const rejection = await createVideoHandler(createTestCtx())
      .poll(JOB_ID, minimaxRequest(), {})
      .catch((error: unknown) => error);
    expect((rejection as RetryableProviderError).kind).toBe("network");
  });

  it("a result without video.url throws a plain Error", async () => {
    stubFetch(jsonResponse(200, { status: "COMPLETED" }), jsonResponse(200, { images: [] }));
    await expect(
      createVideoHandler(createTestCtx()).poll(JOB_ID, minimaxRequest(), {})
    ).rejects.toThrow(/^\[ai\] fal returned an incomplete result\./);
  });

  it("a job id that is not JSON throws a plain Error", async () => {
    const fetchMock = stubFetch();
    await expect(
      createVideoHandler(createTestCtx()).poll("req-1", minimaxRequest(), {})
    ).rejects.toThrow(/^\[ai\] fal job id "req-1" is not valid\./);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a JSON job id missing fields throws a plain Error", async () => {
    await expect(
      createVideoHandler(createTestCtx()).poll('{"requestId":"r"}', minimaxRequest(), {})
    ).rejects.toThrow(/is not valid/);
  });

  it("requires the key", async () => {
    stubFetch();
    const handler = createVideoHandler(createTestCtx({ env: createFakeEnv({}) }));
    await expect(handler.poll(JOB_ID, minimaxRequest(), {})).rejects.toThrow(
      "[ai] FAL_KEY is not set."
    );
  });
});
