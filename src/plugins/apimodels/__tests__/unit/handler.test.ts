import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  EstimateRequest,
  VideoFile,
  VideoJobPoll,
  VideoRequest
} from "../../../video/contract";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "../../errors";
import { fileNameOf } from "../../upload";
import { createVideoHandler } from "../../video/handler";
import type { TempFiles } from "./fixtures";
import {
  BASE,
  bytesResponse,
  CLIP,
  completedTask,
  createFakeEnv,
  createFakeJournal,
  createTempFiles,
  createTestCtx,
  envelope,
  jsonBodyOf,
  jsonResponse,
  logCalls,
  loggedText,
  PROMPT,
  publicUrlOf,
  recordKey,
  rejectionOf,
  resultUrlOf,
  stubApi,
  stubFetch,
  TEST_KEY,
  thrownBy
} from "./fixtures";

const ACCOUNT = createHash("sha256").update(`moku-ai:${TEST_KEY}`).digest("hex").slice(0, 12);

let temp: TempFiles;
let anna: VideoFile;
let ben: VideoFile;
let voice: VideoFile;
let tail: VideoFile;
let end: VideoFile;

beforeAll(() => {
  temp = createTempFiles();
  anna = temp.file("anna.png", new Uint8Array([1]), "image/png", "a".repeat(64));
  ben = temp.file("ben.png", new Uint8Array([2]), "image/png", "b".repeat(64));
  voice = temp.file("voice.mp3", new Uint8Array([3]), "audio/mpeg", "c".repeat(64));
  tail = temp.file("tail.mp4", new Uint8Array([4]), "video/mp4", "d".repeat(64));
  end = temp.file("end.png", new Uint8Array([5]), "image/png", "e".repeat(64));
});

afterAll(() => {
  temp.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The public URL the fake API hands out for `file`. */
function urlOf(file: VideoFile): string {
  return publicUrlOf(fileNameOf(file));
}

/** A seedance-2.5 request for anna, 8 s. */
function shot(overrides: Partial<VideoRequest> = {}): VideoRequest {
  return { model: "seedance-2.5", prompt: PROMPT, image: anna, seconds: 8, ...overrides };
}

/** A job id as submit encodes it. */
function jobIdOf(taskId = "task-1", assetUsd = 0, model = "seedance-2.5"): string {
  return JSON.stringify({ taskId, model, assetUsd });
}

/** Asserts a poll result is `failed` and returns its error. */
function failedError(result: VideoJobPoll): unknown {
  if (result.state !== "failed") throw new Error(`expected failed, got ${result.state}`);
  return result.error;
}

/** A failed task poll body. */
function failedTask(failure: Record<string, unknown>): Response {
  return envelope({ taskId: "task-1", state: "failed", ...failure });
}

/**
 * Asserts a poll error is the plain key error: no status, no kind, so the
 * runner classifies it `unknown` and keeps the task adoptable.
 */
function expectPollAuthError(error: unknown): void {
  expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
  expect(error).not.toHaveProperty("status");
  expect(error).not.toHaveProperty("kind");
  expect((error as Error).message).toBe(
    "[ai] apimodels cannot poll without a valid API key.\n  Fix APIMODELS_API_KEY; the next run adopts the same task."
  );
}

/** A submit apimodels rejects because an asset id is stale. */
function staleAnswer(): Response {
  return jsonResponse(400, {
    code: 400,
    msg: "invalid input",
    data: { failCode: "INVALID_INPUT", failMsg: "asset://old is not in your library" }
  });
}

describe("estimate", () => {
  it("is seconds x price plus 0.01 per named asset, on unresolved inputs, with no network call", () => {
    const fetchMock = stubFetch();
    const handler = createVideoHandler(createTestCtx({ env: createFakeEnv({}) }));

    expect(handler.estimate(shot()).usd).toBe(2.16);
    const unresolved: EstimateRequest = {
      model: "seedance-2.5",
      prompt: "p",
      image: { $file: "cast/anna.png" },
      seconds: 8,
      params: { assets: ["image"] }
    };
    expect(handler.estimate(unresolved).usd).toBe(2.17);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses what submit would refuse, as terminal 400", () => {
    const handler = createVideoHandler(createTestCtx());
    const cases: VideoRequest[] = [
      shot({ model: "seedance-9" }),
      shot({ model: "seedance-2.5-ref", endImage: end }),
      shot({ seconds: 31 }),
      shot({ params: { assets: ["endImage"] } }),
      shot({ params: { assets: "image" } })
    ];
    for (const request of cases) {
      const error = thrownBy(() => handler.estimate(request));
      expect(error).toBeInstanceOf(TerminalProviderError);
      expect(error).toMatchObject({ status: 400 });
    }
  });

  it("leaves the image/* check of named inputs to submit", async () => {
    const api = stubApi();
    const handler = createVideoHandler(createTestCtx());
    const request = shot({
      model: "seedance-2.5-ref",
      refs: [voice],
      params: { assets: ["refs.0"] }
    });

    expect(handler.estimate(request).usd).toBe(2.17);
    const error = await rejectionOf(() => handler.submit(request, {}));
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toContain("which is audio/mpeg");
    expect(api.fetchMock).not.toHaveBeenCalled();
  });
});

describe("submit", () => {
  it.each([
    [
      "seedance-2.5",
      () => shot({ endImage: end }),
      {
        model: "seedance-2.5",
        prompt: PROMPT,
        resolution: "720p",
        duration: 8,
        generate_audio: false,
        first_frame_url: "anna",
        last_frame_url: "end"
      }
    ],
    [
      "seedance-2.5-ref",
      () => shot({ model: "seedance-2.5-ref", refs: [ben, voice, tail], resolution: "480p" }),
      {
        model: "seedance-2.5",
        prompt: PROMPT,
        resolution: "480p",
        duration: 8,
        aspect_ratio: "9:16",
        generate_audio: false,
        reference_image_urls: ["anna", "ben"],
        reference_audio_urls: ["voice"],
        reference_video_urls: ["tail"]
      }
    ],
    [
      "seedance-2.0",
      () => shot({ model: "seedance-2.0", seconds: 5, resolution: "1080p", audio: false }),
      {
        model: "seedance-2.0-official",
        prompt: PROMPT,
        resolution: "1080p",
        duration: 5,
        generate_audio: false,
        first_frame_url: "anna"
      }
    ],
    [
      "seedance-2.0-ref",
      () => shot({ model: "seedance-2.0-ref", refs: [ben], aspect: "16:9" }),
      {
        model: "seedance-2.0-official",
        prompt: PROMPT,
        resolution: "720p",
        duration: 8,
        aspect_ratio: "16:9",
        generate_audio: false,
        reference_image_urls: ["anna", "ben"]
      }
    ]
  ])("%s: uploads the inputs and POSTs the mapped body", async (alias, request, expected) => {
    const api = stubApi();
    const handler = createVideoHandler(createTestCtx());
    const files: Record<string, VideoFile> = { anna, ben, voice, tail, end };
    const withUrls = JSON.parse(
      JSON.stringify(expected).replaceAll(/"(anna|ben|voice|tail|end)"/g, (_match, name: string) =>
        JSON.stringify(urlOf(files[name] as VideoFile))
      )
    ) as Record<string, unknown>;

    const { jobId } = await handler.submit(request(), {});

    const [post] = api.calls("submit");
    expect(post?.url).toBe(`${BASE}/video/generations`);
    expect(post?.headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(jsonBodyOf(post)).toEqual(withUrls);
    expect(JSON.parse(jobId)).toEqual({ taskId: "task-1", model: alias, assetUsd: 0 });
  });

  it("sends a named input as asset:// and strips params.assets from the body", async () => {
    const api = stubApi();
    const handler = createVideoHandler(createTestCtx());

    const { jobId } = await handler.submit(
      shot({ params: { assets: ["image"], output_format: "mov" } }),
      {}
    );

    expect(api.calls().map(call => call.url)).toEqual([
      `${BASE}/files`,
      `${BASE}/assets/groups`,
      `${BASE}/assets`,
      `${BASE}/video/generations`
    ]);
    const body = jsonBodyOf(api.calls("submit")[0]);
    expect(body.first_frame_url).toBe("asset://asset-1");
    expect(body.output_format).toBe("mov");
    expect(body).not.toHaveProperty("assets");
    expect(JSON.parse(jobId)).toEqual({ taskId: "task-1", model: "seedance-2.5", assetUsd: 0.01 });
  });

  it("sends the same bytes as asset:// where named and as https where not", async () => {
    const api = stubApi();
    const handler = createVideoHandler(createTestCtx());

    await handler.submit(
      shot({ model: "seedance-2.5-ref", refs: [anna, ben], params: { assets: ["image"] } }),
      {}
    );

    expect(jsonBodyOf(api.calls("submit")[0]).reference_image_urls).toEqual([
      "asset://asset-1",
      urlOf(anna),
      urlOf(ben)
    ]);
    expect(api.count("upload")).toBe(2);
  });

  it("writes the journal once per submit", async () => {
    stubApi();
    const journal = createFakeJournal();
    const handler = createVideoHandler(createTestCtx({ journal }));

    await handler.submit(
      shot({ model: "seedance-2.5-ref", refs: [ben], params: { assets: ["image", "refs.0"] } }),
      {}
    );

    expect(journal.putProviderRecords).toHaveBeenCalledTimes(1);
    expect(
      journal.records.get(
        recordKey({ provider: "apimodels", account: ACCOUNT, kind: "asset", key: ben.hash })
      )
    ).toBe("asset://asset-2");
  });

  it("throws a terminal 401 when the key is missing, before any fetch", async () => {
    const fetchMock = stubFetch();
    const handler = createVideoHandler(createTestCtx({ env: createFakeEnv({}) }));

    const error = await rejectionOf(() => handler.submit(shot(), {}));

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({ status: 401 });
    expect((error as Error).message).toBe(
      "[ai] apimodels needs an API key.\n  Set APIMODELS_API_KEY (or the env var named by apimodels.apiKeyEnv)."
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a bad request before any fetch", async () => {
    const fetchMock = stubFetch();
    const handler = createVideoHandler(createTestCtx());
    const error = await rejectionOf(() => handler.submit(shot({ refs: [ben] }), {}));
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not POST when the caller aborted during the uploads", async () => {
    const controller = new AbortController();
    const api = stubApi({
      upload: (_n, form) => {
        controller.abort(new Error("paused"));
        return envelope({ publicUrl: publicUrlOf((form.get("file") as File).name) });
      }
    });
    const handler = createVideoHandler(createTestCtx());

    const error = await rejectionOf(() => handler.submit(shot(), { signal: controller.signal }));

    expect((error as Error).message).toBe("paused");
    expect(api.count("submit")).toBe(0);
  });

  it("finishes a POST already sent when the caller aborts, so the billed task id is returned", async () => {
    const controller = new AbortController();
    const api = stubApi({
      submit: () => {
        controller.abort(new Error("paused"));
        return envelope({ taskId: "task-7", state: "pending" });
      }
    });
    const handler = createVideoHandler(createTestCtx());

    const { jobId } = await handler.submit(shot(), { signal: controller.signal });

    expect(JSON.parse(jobId)).toMatchObject({ taskId: "task-7" });
    expect(api.count("submit")).toBe(1);
  });

  it("throws a terminal error when the submit response has no taskId", async () => {
    stubApi({ submit: () => envelope({ state: "pending" }) });
    const handler = createVideoHandler(createTestCtx());
    const error = await rejectionOf(() => handler.submit(shot(), {}));
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toBe(
      "[ai] apimodels returned an incomplete submit response.\n  Expected data.taskId; check the apimodels API for a change."
    );
  });

  it("maps a submit answered with state failed like a failed poll", async () => {
    stubApi({
      submit: () =>
        envelope({
          taskId: "task-1",
          state: "failed",
          failCode: "CONTENT_MODERATION",
          failMsg: "nsfw"
        })
    });
    const handler = createVideoHandler(createTestCtx());
    expect(await rejectionOf(() => handler.submit(shot(), {}))).toBeInstanceOf(
      FlaggedProviderError
    );
  });

  it("logs the ignored negative prompt at debug, without its text", async () => {
    const api = stubApi();
    const ctx = createTestCtx();

    await createVideoHandler(ctx).submit(shot({ negative: "blurry hands" }), {});

    expect(logCalls(ctx, "debug")).toContainEqual([
      "apimodels:negative:ignored",
      { model: "seedance-2.5" }
    ]);
    expect(JSON.stringify(jsonBodyOf(api.calls("submit")[0]))).not.toContain("blurry");
    expect(loggedText(ctx)).not.toContain("blurry");
  });

  it("a 422 on register is flagged before any clip is paid", async () => {
    const api = stubApi({ register: () => jsonResponse(422, { code: 422, msg: "moderation" }) });
    const handler = createVideoHandler(createTestCtx());

    const error = await rejectionOf(() =>
      handler.submit(shot({ params: { assets: ["image"] } }), {})
    );

    expect(error).toBeInstanceOf(FlaggedProviderError);
    expect(api.count("submit")).toBe(0);
  });

  it("stale asset at submit: drops the records and throws retryable 503, the second time terminal 400", async () => {
    const api = stubApi({ submit: staleAnswer });
    const journal = createFakeJournal();
    const key = recordKey({
      provider: "apimodels",
      account: ACCOUNT,
      kind: "asset",
      key: anna.hash
    });
    journal.records.set(key, "asset://old");
    const ctx = createTestCtx({ journal });
    const handler = createVideoHandler(ctx);
    const request = shot({ params: { assets: ["image"] } });

    const first = await rejectionOf(() => handler.submit(request, {}));

    expect(first).toBeInstanceOf(RetryableProviderError);
    expect(first).toMatchObject({ status: 503, kind: "resubmit" });
    expect(jsonBodyOf(api.calls("submit")[0]).first_frame_url).toBe("asset://old");
    expect(journal.records.has(key)).toBe(false);
    expect(ctx.state.assets.size).toBe(0);

    const second = await rejectionOf(() => handler.submit(request, {}));

    expect(api.count("register")).toBe(1);
    expect(jsonBodyOf(api.calls("submit")[1]).first_frame_url).toBe("asset://asset-1");
    expect(second).toBeInstanceOf(TerminalProviderError);
    expect(second).toMatchObject({ status: 400 });
  });

  it("two items sharing a face each get the retryable path on their first stale answer", async () => {
    const api = stubApi({ submit: staleAnswer });
    const handler = createVideoHandler(createTestCtx());
    const first = shot({ prompt: "She turns to the window.", params: { assets: ["image"] } });
    const second = shot({ prompt: "She smiles at the camera.", params: { assets: ["image"] } });

    const firstError = await rejectionOf(() => handler.submit(first, {}));
    const secondError = await rejectionOf(() => handler.submit(second, {}));

    expect(firstError).toBeInstanceOf(RetryableProviderError);
    expect(secondError).toBeInstanceOf(RetryableProviderError);
    expect(secondError).toMatchObject({ status: 503, kind: "resubmit" });
    expect(api.count("submit")).toBe(2);
  });

  it("two concurrent submits with the same face: one POST /files, one POST /assets/groups, one POST /assets", async () => {
    const api = stubApi();
    const ctx = createTestCtx();
    const handler = createVideoHandler(ctx);

    const jobs = await Promise.all([
      handler.submit(shot({ prompt: "one", params: { assets: ["image"] } }), {}),
      handler.submit(shot({ prompt: "two", params: { assets: ["image"] } }), {})
    ]);

    expect(api.count("upload")).toBe(1);
    expect(api.count("group")).toBe(1);
    expect(api.count("register")).toBe(1);
    expect(api.count("submit")).toBe(2);
    expect(api.calls("submit").map(call => jsonBodyOf(call).first_frame_url)).toEqual([
      "asset://asset-1",
      "asset://asset-1"
    ]);
    const assetUsd = jobs.map(job => (JSON.parse(job.jobId) as { assetUsd: number }).assetUsd);
    expect(assetUsd.toSorted((left, right) => left - right)).toEqual([0, 0.01]);
  });

  it("an INVALID_INPUT naming an asset is terminal when the request named no assets", async () => {
    stubApi({
      submit: () =>
        jsonResponse(400, {
          code: 400,
          data: { failCode: "INVALID_INPUT", failMsg: "asset missing" }
        })
    });
    const error = await rejectionOf(() => createVideoHandler(createTestCtx()).submit(shot(), {}));
    expect(error).toBeInstanceOf(TerminalProviderError);
  });

  it("logs the submit with ids only: never the key or the prompt", async () => {
    stubApi();
    const ctx = createTestCtx();

    await createVideoHandler(ctx).submit(shot({ params: { assets: ["image"] } }), {});

    expect(logCalls(ctx, "info")).toContainEqual([
      "apimodels:video:submitted",
      { model: "seedance-2.5", taskId: "task-1" }
    ]);
    expect(loggedText(ctx)).not.toContain(TEST_KEY);
    expect(loggedText(ctx)).not.toContain(PROMPT);
  });
});

describe("poll", () => {
  it.each([
    ["pending"],
    ["processing"],
    ["queued-somewhere"]
  ])("state %s reads as pending", async state => {
    const api = stubApi({ poll: taskId => envelope({ taskId, state }) });
    const handler = createVideoHandler(createTestCtx());

    expect(await handler.poll(jobIdOf(), shot(), {})).toEqual({ state: "pending" });
    const [call] = api.calls("poll");
    expect(call?.url).toBe(`${BASE}/video/generations?task_id=task-1`);
    expect(call?.headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
  });

  it("logs an unknown state once per poll", async () => {
    stubApi({ poll: taskId => envelope({ taskId, state: "warming-up" }) });
    const ctx = createTestCtx();
    await createVideoHandler(ctx).poll(jobIdOf(), shot(), {});
    expect(logCalls(ctx, "warn")).toContainEqual([
      "apimodels:poll:unknown-state",
      { taskId: "task-1", state: "warming-up" }
    ]);
  });

  it("completed: downloads resultUrls[0] without the key and returns done with the table price plus assetUsd", async () => {
    const api = stubApi({ poll: completedTask });
    const handler = createVideoHandler(createTestCtx());

    const result = await handler.poll(jobIdOf("task-1", 0.01), shot(), {});

    expect(result).toEqual({
      state: "done",
      video: CLIP,
      mimeType: "video/mp4",
      costUsd: 2.17,
      meta: { taskId: "task-1", model: "seedance-2.5", seconds: 8 }
    });
    const [download] = api.calls("download");
    expect(download?.url).toBe(resultUrlOf("task-1"));
    expect(download?.headers.Authorization).toBeUndefined();
    expect(api.calls("records")[0]?.url).toBe(`${BASE}/records/task-1`);
  });

  it("uses the settled USD charge from /records, plus assetUsd", async () => {
    stubApi({
      poll: completedTask,
      records: () => envelope({ settled: true, credits: 1.5, currency: "USD" })
    });
    const result = await createVideoHandler(createTestCtx()).poll(
      jobIdOf("task-1", 0.02),
      shot(),
      {}
    );
    expect(result).toMatchObject({ state: "done", costUsd: 1.52 });
  });

  it.each([
    ["not settled", () => envelope({ settled: false, credits: 1.5, currency: "USD" })],
    ["another currency", () => envelope({ settled: true, credits: 10, currency: "CNY" })],
    ["HTTP 500", () => jsonResponse(500, {})],
    ["unreadable", () => new Response("<html>", { status: 200 })],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))]
  ])("falls back to the table price when /records is %s, and never fails the poll", async (_label, records) => {
    stubApi({ poll: completedTask, records });
    const result = await createVideoHandler(createTestCtx()).poll(jobIdOf(), shot(), {});
    expect(result).toMatchObject({ state: "done", costUsd: 2.16 });
  });

  it("takes the MIME type from the download, else video/mp4", async () => {
    stubApi({ poll: completedTask, download: () => bytesResponse(CLIP, "video/quicktime") });
    const handler = createVideoHandler(createTestCtx());
    expect(await handler.poll(jobIdOf(), shot(), {})).toMatchObject({
      mimeType: "video/quicktime"
    });

    stubApi({
      poll: completedTask,
      download: () => bytesResponse(CLIP, "application/octet-stream")
    });
    expect(await handler.poll(jobIdOf(), shot(), {})).toMatchObject({ mimeType: "video/mp4" });
  });

  it.each([
    [403],
    [404],
    [410]
  ])("a dead result URL (HTTP %d) returns failed with a retryable 503, kind resubmit", async status => {
    stubApi({ poll: completedTask, download: () => new Response("gone", { status }) });
    const ctx = createTestCtx();

    const error = failedError(await createVideoHandler(ctx).poll(jobIdOf(), shot(), {}));

    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ status: 503, kind: "resubmit" });
    expect((error as Error).message).toBe(
      `[ai] apimodels finished the task, but its result is gone (HTTP ${status}).\n  Results live 7 days; the runner submits the task again, and it is paid again.`
    );
  });

  it("a download 5xx is thrown retryable, so the job stays pending", async () => {
    stubApi({ poll: completedTask, download: () => new Response("", { status: 502 }) });
    const error = await rejectionOf(() =>
      createVideoHandler(createTestCtx()).poll(jobIdOf(), shot(), {})
    );
    expect(error).toBeInstanceOf(RetryableProviderError);
  });

  it("another download 4xx is thrown as a retryable 503, so the paid clip is polled again", async () => {
    stubApi({ poll: completedTask, download: () => new Response("", { status: 400 }) });
    const error = await rejectionOf(() =>
      createVideoHandler(createTestCtx()).poll(jobIdOf(), shot(), {})
    );
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ status: 503, kind: undefined });
  });

  it("completed without a result URL is thrown retryable (poll again)", async () => {
    stubApi({ poll: taskId => envelope({ taskId, state: "completed", resultUrls: [] }) });
    const error = await rejectionOf(() =>
      createVideoHandler(createTestCtx()).poll(jobIdOf(), shot(), {})
    );
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ status: 503, kind: undefined });
  });

  it("an unknown task (HTTP 404, or envelope code 404) returns failed with a retryable 503, kind resubmit", async () => {
    stubApi({ poll: () => jsonResponse(404, { code: 404, msg: "task not found" }) });
    const handler = createVideoHandler(createTestCtx());
    const error = failedError(await handler.poll(jobIdOf(), shot(), {}));
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ status: 503, kind: "resubmit" });
    expect((error as Error).message).toBe(
      '[ai] apimodels does not know task "task-1" (HTTP 404).\n  The runner submits it again, and it is paid again.'
    );

    stubApi({ poll: () => envelope(undefined, 404) });
    expect(failedError(await handler.poll(jobIdOf(), shot(), {}))).toMatchObject({
      status: 503,
      kind: "resubmit"
    });
  });

  it("failed with CONTENT_MODERATION returns flagged", async () => {
    stubApi({
      poll: () =>
        failedTask({ failCode: "CONTENT_MODERATION", failMsg: "real person", retryable: false })
    });
    const error = failedError(
      await createVideoHandler(createTestCtx()).poll(jobIdOf(), shot(), {})
    );
    expect(error).toBeInstanceOf(FlaggedProviderError);
    expect((error as Error).message).toBe(
      "[ai] apimodels flagged the task (content moderation): real person.\n  Change the prompt or the inputs."
    );
  });

  it.each([
    ["UPSTREAM_BUSY"],
    ["UPSTREAM_FAILED"],
    ["TIMEOUT"],
    ["INTERNAL_ERROR"],
    ["OTHER"]
  ])("failed with the retryable code %s returns a retryable 503, no kind", async failCode => {
    stubApi({ poll: () => failedTask({ failCode, failMsg: "try later" }) });
    const error = failedError(
      await createVideoHandler(createTestCtx()).poll(jobIdOf(), shot(), {})
    );
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ status: 503, kind: undefined });
    expect((error as Error).message).toBe(
      `[ai] apimodels task failed (${failCode}): try later.\n  The runner submits it again.`
    );
  });

  it.each([
    ["INVALID_INPUT"],
    ["INSUFFICIENT_BALANCE"],
    [undefined]
  ])("failed with %s returns a terminal 400", async failCode => {
    stubApi({ poll: () => failedTask({ failCode, failMsg: "no" }) });
    const error = failedError(
      await createVideoHandler(createTestCtx()).poll(jobIdOf(), shot(), {})
    );
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({ status: 400 });
  });

  it("data.retryable wins over the failCode when present", async () => {
    stubApi({
      poll: () => failedTask({ failCode: "INVALID_INPUT", failMsg: "x", retryable: true })
    });
    const handler = createVideoHandler(createTestCtx());
    expect(failedError(await handler.poll(jobIdOf(), shot(), {}))).toBeInstanceOf(
      RetryableProviderError
    );

    stubApi({
      poll: () => failedTask({ failCode: "UPSTREAM_BUSY", failMsg: "x", retryable: false })
    });
    expect(failedError(await handler.poll(jobIdOf(), shot(), {}))).toBeInstanceOf(
      TerminalProviderError
    );
  });

  it("failed with INVALID_INPUT naming an asset: drops the records and returns retryable, then terminal", async () => {
    stubApi({
      poll: () =>
        failedTask({ failCode: "INVALID_INPUT", failMsg: "asset expired", retryable: false })
    });
    const journal = createFakeJournal();
    const key = recordKey({
      provider: "apimodels",
      account: ACCOUNT,
      kind: "asset",
      key: anna.hash
    });
    journal.records.set(key, "asset://a1");
    const ctx = createTestCtx({ journal });
    ctx.state.assets.set(`${ACCOUNT}:${anna.hash}`, "asset://a1");
    const handler = createVideoHandler(ctx);
    const request = shot({ params: { assets: ["image"] } });

    const first = failedError(await handler.poll(jobIdOf("task-1", 0.01), request, {}));

    expect(first).toBeInstanceOf(RetryableProviderError);
    expect(first).toMatchObject({ status: 503, kind: "resubmit" });
    expect(journal.records.has(key)).toBe(false);
    expect(ctx.state.assets.size).toBe(0);

    const second = failedError(await handler.poll(jobIdOf("task-2", 0.01), request, {}));

    expect(second).toBeInstanceOf(TerminalProviderError);
    expect(second).toMatchObject({ status: 400 });
  });

  it("a stale asset seen at submit and then at poll for the same inputs is terminal the second time", async () => {
    stubApi({
      submit: () =>
        jsonResponse(400, {
          code: 400,
          data: { failCode: "INVALID_INPUT", failMsg: "asset gone" }
        }),
      poll: () => failedTask({ failCode: "INVALID_INPUT", failMsg: "asset gone" })
    });
    const handler = createVideoHandler(createTestCtx());
    const request = shot({ params: { assets: ["image"] } });

    expect(await rejectionOf(() => handler.submit(request, {}))).toBeInstanceOf(
      RetryableProviderError
    );
    expect(failedError(await handler.poll(jobIdOf(), request, {}))).toBeInstanceOf(
      TerminalProviderError
    );
  });

  it.each([
    ["HTTP 429", () => jsonResponse(429, {}, { "retry-after": "1" }), { status: 429 }],
    ["HTTP 503", () => jsonResponse(503, {}), { status: 503 }],
    [
      "a network failure",
      () => Promise.reject(new TypeError("fetch failed")),
      { status: undefined, kind: "network" }
    ]
  ])("%s on the poll itself is thrown retryable with its own hint (the runner keeps the job pending)", async (_label, poll, hint) => {
    stubApi({ poll });
    const error = await rejectionOf(() =>
      createVideoHandler(createTestCtx()).poll(jobIdOf(), shot(), {})
    );
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject(hint);
    expect((error as RetryableProviderError).kind).not.toBe("resubmit");
  });

  it.each([
    [401],
    [403]
  ])("an HTTP %d on the poll is thrown as a plain error with no status (the runner marks the job expired)", async status => {
    stubApi({ poll: () => jsonResponse(status, {}) });

    const error = await rejectionOf(() =>
      createVideoHandler(createTestCtx()).poll(jobIdOf(), shot(), {})
    );

    expectPollAuthError(error);
  });

  it("an envelope code 401 on the poll is thrown as the same plain error", async () => {
    stubApi({ poll: () => envelope(undefined, 401) });
    const error = await rejectionOf(() =>
      createVideoHandler(createTestCtx()).poll(jobIdOf(), shot(), {})
    );
    expectPollAuthError(error);
  });

  it("a missing key at poll time is thrown as the same plain error, before any fetch", async () => {
    const fetchMock = stubFetch();
    const handler = createVideoHandler(createTestCtx({ env: createFakeEnv({}) }));

    const error = await rejectionOf(() => handler.poll(jobIdOf(), shot(), {}));

    expectPollAuthError(error);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a malformed job id is thrown as a plain error with no status (the runner marks the job expired), before any fetch", async () => {
    const fetchMock = stubFetch();
    const error = await rejectionOf(() =>
      createVideoHandler(createTestCtx()).poll("nope", shot(), {})
    );
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    expect(error).not.toHaveProperty("status");
    expect(error).not.toHaveProperty("kind");
    expect((error as Error).message).toBe(
      '[ai] apimodels job id "nope" is not valid.\n  Expected the JSON job id returned by apimodels submit.'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never puts the prompt or the key in an error message or a log line", async () => {
    stubApi({
      poll: () =>
        failedTask({ failCode: "INVALID_INPUT", failMsg: `bad prompt: ${PROMPT} ${TEST_KEY}` })
    });
    const ctx = createTestCtx();

    const error = failedError(await createVideoHandler(ctx).poll(jobIdOf(), shot(), {}));

    expect((error as Error).message).not.toContain(PROMPT);
    expect((error as Error).message).not.toContain(TEST_KEY);
    expect(loggedText(ctx)).not.toContain(PROMPT);
    expect(loggedText(ctx)).not.toContain(TEST_KEY);
  });
});
