import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { VideoFile, VideoJobPoll, VideoRequest } from "../../../video/contract";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "../../types";
import { createVideoHandler } from "../../video/handler";
import type { TempFiles } from "../fixtures";
import {
  ASSET_ID,
  arkRecord,
  bytesResponse,
  CN_TASKS_URL,
  CREATE_TASK_REQUEST_ASSET_FIRST_FRAME,
  CREATE_TASK_REQUEST_CN_FIRST_FRAME,
  CREATE_TASK_REQUEST_FIRST_FRAME,
  CREATE_TASK_REQUEST_REFERENCES,
  CREATE_TASK_RESPONSE,
  callsOf,
  createFakeEnv,
  createTempFiles,
  createTestCtx,
  ERROR_INTERNAL,
  ERROR_RATE_LIMIT,
  ERROR_SENSITIVE_IMAGE,
  GET_ASSET_ACTIVE,
  GET_ASSET_FAILED,
  GET_ASSET_PROCESSING,
  GET_ASSET_REQUEST,
  GET_TASK_CANCELLED,
  GET_TASK_EXPIRED,
  GET_TASK_FAILED,
  GET_TASK_FAILED_SENSITIVE,
  GET_TASK_QUEUED,
  GET_TASK_RUNNING,
  GET_TASK_SUCCEEDED,
  GET_TASK_SUCCEEDED_CN,
  INTL_TASKS_URL,
  intlActionUrl,
  jsonBodyOf,
  jsonResponse,
  LAST_FRAME_URL,
  LOCAL_IMAGE_BYTES,
  loggedText,
  stubFetch,
  TASK_ID,
  TEST_ACCESS_KEY,
  TEST_API_KEY,
  TEST_SECRET_KEY,
  VIDEO_URL
} from "../fixtures";

const MODEL_ID = "dreamina-seedance-2-0-260128";
const PROMPT = "A girl walks into the rain, the camera follows her";
const CLIP = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
const TASK_URL = `${INTL_TASKS_URL}/${TASK_ID}`;
const FACE_MESSAGE =
  "[ai] ark refused an image with a face: InputImageSensitiveContentDetected.PrivacyInformation.\n  Make it an asset item and $ref it.";
const GENERIC_FLAG_MESSAGE =
  "[ai] ark flagged the request: InputImageSensitiveContentDetected.PrivacyInformation.\n  Change the prompt or the inputs.";

let temp: TempFiles;
let image: VideoFile;
let asset: VideoFile;

beforeAll(() => {
  temp = createTempFiles();
  image = temp.file("key.png", LOCAL_IMAGE_BYTES, "image/png");
  asset = temp.asset("mira.asset.json", arkRecord());
});

afterAll(() => {
  temp.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A request for the intl Seedance 2.0 row. */
function request(overrides: Partial<VideoRequest> = {}): VideoRequest {
  return { model: MODEL_ID, prompt: PROMPT, ...overrides };
}

/** What a promise rejected with. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

/** Asserts a poll result is `failed` and returns its error. */
function failedError(result: VideoJobPoll): unknown {
  if (result.state !== "failed") throw new Error(`expected failed, got ${result.state}`);
  return result.error;
}

describe("estimate", () => {
  it("prices tokens of the default 5 s at 720p, without any network call", () => {
    const fetchMock = stubFetch();
    const handler = createVideoHandler(createTestCtx());

    expect(handler.estimate(request())).toEqual({ usd: 0.756 });
    expect(handler.estimate(request({ seconds: 10, resolution: "480p" }))).toEqual({ usd: 0.6804 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts unresolved $ref and $file inputs and never reads them", () => {
    const handler = createVideoHandler(createTestCtx());
    const unresolved = {
      ...request(),
      image: { $ref: "face-mira" },
      refs: [{ $file: "refs/street.png" }]
    } as unknown as VideoRequest;

    expect(handler.estimate(unresolved)).toEqual({ usd: 0.756 });
  });

  it("converts the cn price to USD", () => {
    const handler = createVideoHandler(createTestCtx({ config: { region: "cn" } }));
    expect(handler.estimate(request({ model: "doubao-seedance-2-0-260128" }))).toEqual({
      usd: 0.699_718
    });
  });

  it("fails at plan time with the submit errors for model, region, seconds and resolution", () => {
    const handler = createVideoHandler(createTestCtx());

    expect(() => handler.estimate(request({ model: "nope" }))).toThrow('Unknown ark model "nope"');
    expect(() => handler.estimate(request({ model: "doubao-seedance-2-0-260128" }))).toThrow(
      "is a cn model."
    );
    expect(() => handler.estimate(request({ seconds: 2 }))).toThrow("takes 4 to 15 seconds.");
    expect(() => handler.estimate(request({ resolution: "4k" }))).toThrow(
      'does not take resolution "4k".'
    );
  });
});

describe("submit", () => {
  it("POSTs the documented first-frame body with the Bearer key and returns the task id", async () => {
    const fetchMock = stubFetch(jsonResponse(200, CREATE_TASK_RESPONSE));
    const ctx = createTestCtx();

    const result = await createVideoHandler(ctx).submit(request({ image }), {});

    expect(result).toEqual({ jobId: TASK_ID });
    const calls = callsOf(fetchMock);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(INTL_TASKS_URL);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TEST_API_KEY}`);
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
    expect(jsonBodyOf(calls[0])).toEqual(CREATE_TASK_REQUEST_FIRST_FRAME);
    expect(ctx.log.info).toHaveBeenCalledWith("ark:video:submitted", {
      model: MODEL_ID,
      taskId: TASK_ID
    });
  });

  it("uses the cn data plane and the cn model", async () => {
    const fetchMock = stubFetch(jsonResponse(200, CREATE_TASK_RESPONSE));
    const handler = createVideoHandler(createTestCtx({ config: { region: "cn" } }));

    await handler.submit(request({ model: "doubao-seedance-2-0-260128", image }), {});

    const [call] = callsOf(fetchMock);
    expect(call?.url).toBe(CN_TASKS_URL);
    expect(jsonBodyOf(call)).toEqual(CREATE_TASK_REQUEST_CN_FIRST_FRAME);
  });

  it("uses the baseUrl override", async () => {
    const fetchMock = stubFetch(jsonResponse(200, CREATE_TASK_RESPONSE));
    const handler = createVideoHandler(
      createTestCtx({ config: { baseUrl: "https://proxy.example/v3/" } })
    );

    await handler.submit(request({ image }), {});

    expect(callsOf(fetchMock)[0]?.url).toBe("https://proxy.example/v3/contents/generations/tasks");
  });

  it("needs only the API key for a request without asset refs", async () => {
    stubFetch(jsonResponse(200, CREATE_TASK_RESPONSE));
    const handler = createVideoHandler(
      createTestCtx({ env: createFakeEnv({ ARK_API_KEY: TEST_API_KEY }) })
    );

    await expect(handler.submit(request({ image }), {})).resolves.toEqual({ jobId: TASK_ID });
  });

  it("throws before any fetch when the API key is not set", async () => {
    const fetchMock = stubFetch();
    const handler = createVideoHandler(createTestCtx({ env: createFakeEnv({}) }));

    await expect(handler.submit(request({ image }), {})).rejects.toThrow(
      'required variable "ARK_API_KEY"'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws before any fetch for a request the model cannot take", async () => {
    const fetchMock = stubFetch();
    const handler = createVideoHandler(createTestCtx());

    await expect(handler.submit(request({ params: { seed: 1 } }), {})).rejects.toThrow(
      "takes no seed."
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not POST when the caller aborted before the task call", async () => {
    const fetchMock = stubFetch();
    const controller = new AbortController();
    controller.abort(new Error("paused"));

    await expect(
      createVideoHandler(createTestCtx()).submit(request({ image }), { signal: controller.signal })
    ).rejects.toThrow("paused");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("warns once per process that negative is ignored", async () => {
    stubFetch(jsonResponse(200, CREATE_TASK_RESPONSE), jsonResponse(200, CREATE_TASK_RESPONSE));
    const ctx = createTestCtx();
    const handler = createVideoHandler(ctx);

    await handler.submit(request({ negative: "blur" }), {});
    await handler.submit(request({ negative: "blur" }), {});

    const warnings = vi
      .mocked(ctx.log.warn)
      .mock.calls.filter(([event]) => event === "ark:negative:ignored");
    expect(warnings).toEqual([["ark:negative:ignored", { model: MODEL_ID }]]);
  });

  it("throws a plain error when ark answers without a task id", async () => {
    stubFetch(jsonResponse(200, {}));

    const error = await rejectionOf(createVideoHandler(createTestCtx()).submit(request(), {}));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RetryableProviderError);
    expect((error as Error).message).toBe(
      "[ai] ark returned no task id.\n  Check the task list in the console before running again."
    );
  });

  it("maps a 400 face refusal of a plain local image to flagged with the asset hint", async () => {
    stubFetch(jsonResponse(400, ERROR_SENSITIVE_IMAGE));

    const error = await rejectionOf(
      createVideoHandler(createTestCtx()).submit(request({ image }), {})
    );

    expect(error).toBeInstanceOf(FlaggedProviderError);
    expect((error as Error).message).toBe(FACE_MESSAGE);
  });

  it("maps the same refusal without a plain local image to the generic flag", async () => {
    stubFetch(jsonResponse(200, GET_ASSET_ACTIVE), jsonResponse(400, ERROR_SENSITIVE_IMAGE));

    const error = await rejectionOf(
      createVideoHandler(createTestCtx()).submit(request({ image: asset }), {})
    );

    expect(error).toBeInstanceOf(FlaggedProviderError);
    expect((error as Error).message).toBe(GENERIC_FLAG_MESSAGE);
  });

  it("maps 429 to retryable with Retry-After, and 5xx to retryable", async () => {
    stubFetch(jsonResponse(429, ERROR_RATE_LIMIT, { "retry-after": "7" }));
    const handler = createVideoHandler(createTestCtx());

    expect(await rejectionOf(handler.submit(request(), {}))).toMatchObject({
      status: 429,
      retryAfterMs: 7000
    });

    stubFetch(jsonResponse(503, ERROR_INTERNAL));
    const error = await rejectionOf(handler.submit(request(), {}));
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ status: 503 });
  });
});

describe("submit asset preflight", () => {
  it("checks an asset with a signed GetAsset, then POSTs asset:// as the first frame", async () => {
    const fetchMock = stubFetch(
      jsonResponse(200, GET_ASSET_ACTIVE),
      jsonResponse(200, CREATE_TASK_RESPONSE)
    );
    const ctx = createTestCtx();

    await createVideoHandler(ctx).submit(
      request({ prompt: "image 1 walks into the rain", image: asset }),
      {}
    );

    const [getAsset, create] = callsOf(fetchMock);
    expect(getAsset?.url).toBe(intlActionUrl("GetAsset"));
    expect(getAsset?.headers.Authorization).toContain(`Credential=${TEST_ACCESS_KEY}/`);
    expect(jsonBodyOf(getAsset)).toEqual(GET_ASSET_REQUEST);
    expect(jsonBodyOf(create)).toEqual(CREATE_TASK_REQUEST_ASSET_FIRST_FRAME);
    expect(ctx.state.activeAssets.has(ASSET_ID)).toBe(true);
  });

  it("checks each asset once per process", async () => {
    const fetchMock = stubFetch(
      jsonResponse(200, GET_ASSET_ACTIVE),
      jsonResponse(200, CREATE_TASK_RESPONSE),
      jsonResponse(200, CREATE_TASK_RESPONSE)
    );
    const handler = createVideoHandler(createTestCtx());

    await handler.submit(request({ image: asset, refs: [asset] }), {});
    await handler.submit(request({ refs: [asset] }), {});

    const urls = callsOf(fetchMock).map(call => call.url);
    expect(urls).toEqual([intlActionUrl("GetAsset"), INTL_TASKS_URL, INTL_TASKS_URL]);
  });

  it("POSTs the documented multimodal reference body", async () => {
    const fetchMock = stubFetch(
      jsonResponse(200, GET_ASSET_ACTIVE),
      jsonResponse(200, CREATE_TASK_RESPONSE)
    );

    await createVideoHandler(createTestCtx()).submit(
      request({
        prompt: "image 1 walks down the street of image 2 to the beat of audio 1",
        refs: [asset, image],
        seconds: 10,
        audio: true,
        params: {
          refUrls: ["https://cdn.example/motion/walk.mp4", "https://cdn.example/audio/rain.mp3"]
        }
      }),
      {}
    );

    expect(jsonBodyOf(callsOf(fetchMock)[1])).toEqual(CREATE_TASK_REQUEST_REFERENCES);
  });

  it("rejects an asset registered by another provider, with no call", async () => {
    const fetchMock = stubFetch();
    const other = temp.asset("other.asset.json", arkRecord({ provider: "apimodels" }));

    const error = await rejectionOf(
      createVideoHandler(createTestCtx()).submit(request({ refs: [other] }), {})
    );

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toBe(
      `[ai] Asset "${ASSET_ID}" was registered by "apimodels", not ark.\n  Register the portrait with provider ark.`
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an asset of another ark account, with no call", async () => {
    const fetchMock = stubFetch();
    const foreign = temp.asset("foreign.asset.json", arkRecord({ account: "000000000000" }));

    const error = await rejectionOf(
      createVideoHandler(createTestCtx()).submit(request({ image: foreign }), {})
    );

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toBe(
      `[ai] Asset "${ASSET_ID}" belongs to another ark account.\n  Register the portrait again with this account's keys.`
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a Processing or Failed asset with no POST", async () => {
    for (const [response, status] of [
      [GET_ASSET_PROCESSING, "Processing"],
      [GET_ASSET_FAILED, "Failed"]
    ] as const) {
      const fetchMock = stubFetch(jsonResponse(200, response));
      const ctx = createTestCtx();

      const error = await rejectionOf(
        createVideoHandler(ctx).submit(request({ refs: [asset] }), {})
      );

      expect(error).toBeInstanceOf(TerminalProviderError);
      expect((error as Error).message).toBe(
        `[ai] ark asset "${ASSET_ID}" is ${status}.\n  Bump params.generation on its asset item to register again.`
      );
      expect(callsOf(fetchMock).map(call => call.url)).toEqual([intlActionUrl("GetAsset")]);
      expect(ctx.state.activeAssets.size).toBe(0);
    }
  });

  it("names an asset without a status as unknown", async () => {
    stubFetch(jsonResponse(200, { Result: { Id: ASSET_ID } }));

    await expect(
      createVideoHandler(createTestCtx()).submit(request({ refs: [asset] }), {})
    ).rejects.toThrow(`[ai] ark asset "${ASSET_ID}" is unknown.`);
  });

  it("needs the access and secret keys when the request carries an asset ref", async () => {
    const fetchMock = stubFetch();
    const handler = createVideoHandler(
      createTestCtx({ env: createFakeEnv({ ARK_API_KEY: TEST_API_KEY }) })
    );

    await expect(handler.submit(request({ image: asset }), {})).rejects.toThrow(
      'required variable "ARK_ACCESS_KEY"'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not check assets whose ids are already Active in this process", async () => {
    const fetchMock = stubFetch(jsonResponse(200, CREATE_TASK_RESPONSE));
    const ctx = createTestCtx({ state: { activeAssets: new Set([ASSET_ID]) } });

    await createVideoHandler(ctx).submit(request({ image: asset }), {});

    expect(callsOf(fetchMock).map(call => call.url)).toEqual([INTL_TASKS_URL]);
  });
});

describe("poll", () => {
  it("is pending while the task is queued or running", async () => {
    const fetchMock = stubFetch(
      jsonResponse(200, GET_TASK_QUEUED),
      jsonResponse(200, GET_TASK_RUNNING)
    );
    const handler = createVideoHandler(createTestCtx());

    expect(await handler.poll(TASK_ID, request(), {})).toEqual({ state: "pending" });
    expect(await handler.poll(TASK_ID, request(), {})).toEqual({ state: "pending" });
    const [call] = callsOf(fetchMock);
    expect(call?.url).toBe(TASK_URL);
    expect(call?.method).toBe("GET");
    expect(call?.headers.Authorization).toBe(`Bearer ${TEST_API_KEY}`);
  });

  it("downloads the clip on success and prices the completion tokens", async () => {
    const fetchMock = stubFetch(jsonResponse(200, GET_TASK_SUCCEEDED), bytesResponse(CLIP));
    const ctx = createTestCtx();

    const result = await createVideoHandler(ctx).poll(TASK_ID, request({ image }), {});

    expect(result).toEqual({
      state: "done",
      video: CLIP,
      mimeType: "video/mp4",
      costUsd: 0.7623,
      meta: {
        taskId: TASK_ID,
        model: MODEL_ID,
        seconds: 5,
        resolution: "720p",
        completionTokens: 108_900,
        lastFrameUrl: LAST_FRAME_URL
      }
    });
    const download = callsOf(fetchMock)[1];
    expect(download?.url).toBe(VIDEO_URL);
    expect(download?.headers.Authorization).toBeUndefined();
  });

  it("uses the with-video-input price when refUrls holds a video", async () => {
    stubFetch(jsonResponse(200, GET_TASK_SUCCEEDED), bytesResponse(CLIP));

    const result = await createVideoHandler(createTestCtx()).poll(
      TASK_ID,
      request({ params: { refUrls: ["https://cdn.example/motion/walk.mp4"] } }),
      {}
    );

    expect(result).toMatchObject({ state: "done", costUsd: 0.468_27 });
  });

  it("prices a cn task in USD and leaves lastFrameUrl out when there is none", async () => {
    stubFetch(jsonResponse(200, GET_TASK_SUCCEEDED_CN), bytesResponse(CLIP));
    const handler = createVideoHandler(createTestCtx({ config: { region: "cn" } }));

    const result = await handler.poll(
      TASK_ID,
      request({ model: "doubao-seedance-2-0-260128" }),
      {}
    );

    expect(result).toMatchObject({ state: "done", costUsd: 0.705_549 });
    expect(result.state === "done" && result.meta).not.toHaveProperty("lastFrameUrl");
  });

  it("lets priceOverrides win", async () => {
    stubFetch(jsonResponse(200, GET_TASK_SUCCEEDED), bytesResponse(CLIP));
    const handler = createVideoHandler(
      createTestCtx({ config: { priceOverrides: { [MODEL_ID]: 10 } } })
    );

    expect(await handler.poll(TASK_ID, request(), {})).toMatchObject({ costUsd: 1.089 });
  });

  it("falls back to the request's seconds, resolution and estimated tokens", async () => {
    const bare = {
      id: TASK_ID,
      status: "succeeded",
      content: { video_url: VIDEO_URL }
    };
    stubFetch(jsonResponse(200, bare), bytesResponse(CLIP));

    const result = await createVideoHandler(createTestCtx()).poll(
      TASK_ID,
      request({ seconds: 10, resolution: "480p" }),
      {}
    );

    expect(result).toMatchObject({
      state: "done",
      costUsd: 0.6804,
      meta: { model: MODEL_ID, seconds: 10, resolution: "480p", completionTokens: 97_200 }
    });
  });

  it("falls back to 5 s at 720p when neither the task nor the request names them", async () => {
    stubFetch(
      jsonResponse(200, { id: TASK_ID, status: "succeeded", content: { video_url: VIDEO_URL } }),
      bytesResponse(CLIP)
    );

    const result = await createVideoHandler(createTestCtx()).poll(TASK_ID, request(), {});

    expect(result).toMatchObject({
      costUsd: 0.756,
      meta: { seconds: 5, resolution: "720p", completionTokens: 108_000 }
    });
  });

  it("fails terminally on a failed task without code or message", async () => {
    stubFetch(jsonResponse(200, { id: TASK_ID, status: "failed" }));

    const error = failedError(
      await createVideoHandler(createTestCtx()).poll(TASK_ID, request(), {})
    );

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toBe(`[ai] ark task ${TASK_ID} failed (error).`);
  });

  it("flags a SensitiveContent failure of a plain local image with the asset hint", async () => {
    stubFetch(jsonResponse(200, GET_TASK_FAILED_SENSITIVE));
    const ctx = createTestCtx();

    const error = failedError(await createVideoHandler(ctx).poll(TASK_ID, request({ image }), {}));

    expect(error).toBeInstanceOf(FlaggedProviderError);
    expect((error as Error).message).toBe(FACE_MESSAGE);
    expect(ctx.log.warn).toHaveBeenCalledWith("ark:video:failed", {
      taskId: TASK_ID,
      errorType: "flagged",
      code: "InputImageSensitiveContentDetected.PrivacyInformation"
    });
  });

  it("flags a SensitiveContent failure of asset refs only with the generic message", async () => {
    stubFetch(jsonResponse(200, GET_TASK_FAILED_SENSITIVE));

    const error = failedError(
      await createVideoHandler(createTestCtx()).poll(TASK_ID, request({ refs: [asset] }), {})
    );

    expect(error).toBeInstanceOf(FlaggedProviderError);
    expect((error as Error).message).toBe(GENERIC_FLAG_MESSAGE);
  });

  it("fails terminally on another task error, carrying the code and message", async () => {
    stubFetch(jsonResponse(200, GET_TASK_FAILED));

    const error = failedError(
      await createVideoHandler(createTestCtx()).poll(TASK_ID, request(), {})
    );

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({ status: 400, code: "InvalidParameter" });
    expect((error as Error).message).toBe(
      `[ai] ark task ${TASK_ID} failed (InvalidParameter): The parameter \`duration\` specified in the request is not valid.`
    );
  });

  it("fails terminally with 410 on an expired or cancelled task", async () => {
    for (const [body, status] of [
      [GET_TASK_EXPIRED, "expired"],
      [GET_TASK_CANCELLED, "cancelled"]
    ] as const) {
      stubFetch(jsonResponse(200, body));

      const error = failedError(
        await createVideoHandler(createTestCtx()).poll(TASK_ID, request(), {})
      );

      expect(error).toBeInstanceOf(TerminalProviderError);
      expect(error).toMatchObject({ status: 410 });
      expect((error as Error).message).toBe(
        `[ai] ark task ${TASK_ID} is ${status}.\n  Run the item again to submit a new task.`
      );
    }
  });

  it("stays pending on an unknown status, with a warning", async () => {
    stubFetch(jsonResponse(200, { id: TASK_ID, status: "paused" }));
    const ctx = createTestCtx();

    expect(await createVideoHandler(ctx).poll(TASK_ID, request(), {})).toEqual({
      state: "pending"
    });
    expect(ctx.log.warn).toHaveBeenCalledWith("ark:poll:unknown-status", {
      taskId: TASK_ID,
      status: "paused"
    });
  });

  it("throws retryable 502 for a body without status, or a success without video_url", async () => {
    const handler = createVideoHandler(createTestCtx());

    stubFetch(jsonResponse(200, { id: TASK_ID }));
    expect(await rejectionOf(handler.poll(TASK_ID, request(), {}))).toMatchObject({ status: 502 });

    stubFetch(jsonResponse(200, { id: TASK_ID, status: "succeeded", content: {} }));
    const error = await rejectionOf(handler.poll(TASK_ID, request(), {}));
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ status: 502 });
  });

  it("throws retryable on 429 and 5xx, so the runner keeps polling", async () => {
    const handler = createVideoHandler(createTestCtx());

    stubFetch(jsonResponse(429, ERROR_RATE_LIMIT, { "retry-after": "1" }));
    expect(await rejectionOf(handler.poll(TASK_ID, request(), {}))).toMatchObject({
      status: 429,
      retryAfterMs: 1000
    });

    stubFetch(jsonResponse(502, ERROR_INTERNAL));
    expect(await rejectionOf(handler.poll(TASK_ID, request(), {}))).toMatchObject({ status: 502 });
  });

  it("never logs the prompt, a key or a URL", async () => {
    stubFetch(
      jsonResponse(200, GET_ASSET_ACTIVE),
      jsonResponse(200, CREATE_TASK_RESPONSE),
      jsonResponse(200, GET_TASK_SUCCEEDED),
      bytesResponse(CLIP)
    );
    const ctx = createTestCtx();
    const handler = createVideoHandler(ctx);

    await handler.submit(request({ image: asset, negative: "blur" }), {});
    await handler.poll(TASK_ID, request({ image: asset }), {});

    const logged = loggedText(ctx);
    expect(logged).not.toContain(PROMPT);
    expect(logged).not.toContain(TEST_API_KEY);
    expect(logged).not.toContain(TEST_ACCESS_KEY);
    expect(logged).not.toContain(TEST_SECRET_KEY);
    expect(logged).not.toContain("https://");
  });
});
