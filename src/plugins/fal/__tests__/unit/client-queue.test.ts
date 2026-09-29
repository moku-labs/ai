import { afterEach, describe, expect, it, vi } from "vitest";
import type { FalCall, FalJob } from "../../client/queue";
import {
  checkJob,
  decodeJobId,
  downloadFile,
  encodeJobId,
  fetchJobResult,
  mimeFromUrl,
  passthroughParameters,
  pollQueueJob,
  runQueueJob,
  submitJob,
  waitForJob
} from "../../client/queue";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "../../errors";
import {
  bytesResponse,
  callsOf,
  createFakeEnv,
  createTestCtx,
  jsonBodyOf,
  jsonResponse,
  stubFetch,
  submitResponse,
  TEST_KEY
} from "./fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Generic fal queue: submit, status, wait, poll, collect.
// ─────────────────────────────────────────────────────────────────────────────

const JOB: FalJob = {
  endpoint: "fal-ai/nano-banana-pro",
  requestId: "req-9",
  statusUrl: "https://queue.fal.run/x/requests/req-9/status",
  responseUrl: "https://queue.fal.run/x/requests/req-9"
};

const CALL: FalCall = { apiKey: TEST_KEY, timeoutMs: 60_000 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("submitJob", () => {
  it("POSTs the body to <queueUrl>/<endpoint> with the key and returns the job", async () => {
    const fetchMock = stubFetch(submitResponse("req-1"));
    const ctx = createTestCtx();

    const job = await submitJob(ctx, "fal-ai/nano-banana-pro", { prompt: "p" }, CALL);

    const [call] = callsOf(fetchMock);
    expect(call?.url).toBe("https://queue.fal.run/fal-ai/nano-banana-pro");
    expect(call?.method).toBe("POST");
    expect(call?.headers.Authorization).toBe(`Key ${TEST_KEY}`);
    expect(jsonBodyOf(call)).toEqual({ prompt: "p" });
    expect(job).toEqual({
      endpoint: "fal-ai/nano-banana-pro",
      requestId: "req-1",
      statusUrl: "https://queue.fal.run/custom/requests/req-1/status-x",
      responseUrl: "https://queue.fal.run/custom/requests/req-1/result-x"
    });
  });

  it("round-trips through the job id codec", async () => {
    stubFetch(submitResponse("req-2"));
    const job = await submitJob(createTestCtx(), "e", {}, CALL);
    expect(decodeJobId(encodeJobId(job))).toEqual(job);
  });

  it("rejects an incomplete submit response with a plain error", async () => {
    stubFetch(jsonResponse(200, { request_id: "r" }));
    await expect(submitJob(createTestCtx(), "e", {}, CALL)).rejects.toThrow(
      "[ai] fal returned an incomplete submit response."
    );
  });
});

describe("checkJob", () => {
  it.each(["IN_QUEUE", "IN_PROGRESS"])("reads %s as pending", async status => {
    stubFetch(jsonResponse(200, { status }));
    expect(await checkJob(createTestCtx(), JOB, CALL)).toEqual({ state: "pending" });
  });

  it("reads COMPLETED as completed, with the key on the status GET", async () => {
    const fetchMock = stubFetch(jsonResponse(200, { status: "COMPLETED" }));
    expect(await checkJob(createTestCtx(), JOB, CALL)).toEqual({ state: "completed" });
    const [call] = callsOf(fetchMock);
    expect(call?.url).toBe(JOB.statusUrl);
    expect(call?.headers.Authorization).toBe(`Key ${TEST_KEY}`);
  });

  it("reads COMPLETED with an error as failed, classified by jobFailure", async () => {
    stubFetch(jsonResponse(200, { status: "COMPLETED", error: "bad", error_type: "x" }));
    const status = await checkJob(createTestCtx(), JOB, CALL);
    expect(status.state).toBe("failed");
    expect(status.state === "failed" && status.error).toBeInstanceOf(TerminalProviderError);
  });

  it("warns fal:poll:unknown-status and stays pending on an unknown status", async () => {
    stubFetch(jsonResponse(200, { status: "PAUSED" }));
    const ctx = createTestCtx();
    expect(await checkJob(ctx, JOB, CALL)).toEqual({ state: "pending" });
    expect(ctx.log.warn).toHaveBeenCalledWith("fal:poll:unknown-status", {
      requestId: "req-9",
      status: "PAUSED"
    });
  });
});

describe("fetchJobResult and downloadFile", () => {
  it("GETs the result URL with the key", async () => {
    const fetchMock = stubFetch(jsonResponse(200, { images: [] }));
    expect(await fetchJobResult(JOB, CALL)).toEqual({ images: [] });
    const [call] = callsOf(fetchMock);
    expect(call?.url).toBe(JOB.responseUrl);
    expect(call?.headers.Authorization).toBe(`Key ${TEST_KEY}`);
  });

  it("downloads without the key and returns the content-type header", async () => {
    const fetchMock = stubFetch(bytesResponse(new Uint8Array([7, 8]), "image/webp"));
    const file = await downloadFile("https://v3.fal.media/a.webp", { timeoutMs: 1000 });
    expect(file).toEqual({ bytes: new Uint8Array([7, 8]), contentType: "image/webp" });
    expect(callsOf(fetchMock)[0]?.headers.Authorization).toBeUndefined();
  });
});

describe("waitForJob", () => {
  it("checks every pollIntervalMs until the job completes", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(
      jsonResponse(200, { status: "IN_QUEUE" }),
      jsonResponse(200, { status: "IN_PROGRESS" }),
      jsonResponse(200, { status: "COMPLETED" })
    );
    const ctx = createTestCtx({ config: { pollIntervalMs: 2000 } });

    const done = waitForJob(ctx, JOB, CALL);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(done).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after jobTimeoutMs with a retryable timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse(200, { status: "IN_QUEUE" }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createTestCtx({ config: { pollIntervalMs: 2000, jobTimeoutMs: 5000 } });

    const done = waitForJob(ctx, JOB, CALL);
    const failure = expect(done).rejects.toMatchObject({
      name: "RetryableProviderError",
      kind: "timeout",
      message: expect.stringContaining("[ai] fal job req-9 did not finish within 5 s.")
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await failure;
  });

  it("counts a retryable status error as pending and logs fal:poll:retry", async () => {
    stubFetch(jsonResponse(503, {}), jsonResponse(200, { status: "COMPLETED" }));
    const ctx = createTestCtx();

    await waitForJob(ctx, JOB, CALL);

    expect(ctx.log.warn).toHaveBeenCalledWith("fal:poll:retry", {
      requestId: "req-9",
      errorType: "retryable",
      status: 503
    });
  });

  it("rethrows a terminal status error", async () => {
    stubFetch(jsonResponse(404, {}));
    await expect(waitForJob(createTestCtx(), JOB, CALL)).rejects.toBeInstanceOf(
      TerminalProviderError
    );
  });

  it("throws the job's own error when it finished failed", async () => {
    stubFetch(jsonResponse(200, { status: "COMPLETED", error: "nsfw", error_type: "x" }));
    await expect(waitForJob(createTestCtx(), JOB, CALL)).rejects.toBeInstanceOf(
      FlaggedProviderError
    );
  });

  it("an abort during the sleep rejects with the signal's reason", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse(200, { status: "IN_QUEUE" }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const ctx = createTestCtx({ config: { pollIntervalMs: 60_000 } });

    const done = waitForJob(ctx, JOB, { ...CALL, signal: controller.signal });
    const failure = expect(done).rejects.toBe("paused");
    await vi.advanceTimersByTimeAsync(0);
    controller.abort("paused");
    await failure;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("pollQueueJob", () => {
  const collect = vi.fn(async (job: FalJob, apiKey: string) => ({
    got: `${job.requestId}:${apiKey}`
  }));

  it("returns pending while fal works", async () => {
    stubFetch(jsonResponse(200, { status: "IN_QUEUE" }));
    const poll = await pollQueueJob(
      createTestCtx(),
      encodeJobId(JOB),
      undefined,
      "fal:x:failed",
      collect
    );
    expect(poll).toEqual({ state: "pending" });
  });

  it("collects a completed job with the key", async () => {
    stubFetch(jsonResponse(200, { status: "COMPLETED" }));
    const poll = await pollQueueJob(
      createTestCtx(),
      encodeJobId(JOB),
      undefined,
      "fal:x:failed",
      collect
    );
    expect(poll).toEqual({ state: "done", got: `req-9:${TEST_KEY}` });
  });

  it("returns failed with the job error and warns the failed event", async () => {
    stubFetch(jsonResponse(200, { status: "COMPLETED", error: "odd", error_type: "x" }));
    const ctx = createTestCtx();
    const poll = await pollQueueJob(ctx, encodeJobId(JOB), undefined, "fal:x:failed", collect);
    expect(poll.state).toBe("failed");
    expect(ctx.log.warn).toHaveBeenCalledWith("fal:x:failed", {
      requestId: "req-9",
      errorType: "terminal",
      status: 400
    });
  });

  it.each([
    ["a 400", new TerminalProviderError("[ai] fal rejected the request (HTTP 400).", 400)],
    ["a 422", new TerminalProviderError("[ai] fal rejected the request (HTTP 422).", 422)],
    ["a flag", new FlaggedProviderError("[ai] fal flagged the request (content policy).")]
  ])("settles %s from collect as fal's verdict: failed", async (_label, error) => {
    stubFetch(jsonResponse(200, { status: "COMPLETED" }));
    const ctx = createTestCtx();
    const poll = await pollQueueJob(ctx, encodeJobId(JOB), undefined, "fal:x:failed", async () => {
      throw error;
    });
    expect(poll).toEqual({ state: "failed", error });
    expect(ctx.log.warn).toHaveBeenCalledWith(
      "fal:x:failed",
      expect.objectContaining({ requestId: "req-9" })
    );
  });

  it("rethrows another terminal collect failure as retryable 503 (fal:result:unreadable)", async () => {
    stubFetch(jsonResponse(200, { status: "COMPLETED" }));
    const ctx = createTestCtx();
    const poll = pollQueueJob(ctx, encodeJobId(JOB), undefined, "fal:x:failed", async () => {
      throw new TerminalProviderError("[ai] fal rejected the request (HTTP 404).", 404);
    });
    await expect(poll).rejects.toMatchObject({ name: "RetryableProviderError", status: 503 });
    expect(ctx.log.warn).toHaveBeenCalledWith("fal:result:unreadable", {
      requestId: "req-9",
      status: 404
    });
  });

  it("rethrows any other collect error unchanged", async () => {
    stubFetch(jsonResponse(200, { status: "COMPLETED" }));
    const plain = new Error("[ai] fal returned an incomplete image result.");
    const poll = pollQueueJob(
      createTestCtx(),
      encodeJobId(JOB),
      undefined,
      "fal:x:failed",
      async () => {
        throw plain;
      }
    );
    await expect(poll).rejects.toBe(plain);
  });

  it("keeps the job adoptable without a key: a plain error names the variable", async () => {
    const fetchMock = stubFetch();
    const ctx = createTestCtx({ env: createFakeEnv({}) });
    const poll = pollQueueJob(ctx, encodeJobId(JOB), undefined, "fal:x:failed", collect);
    await expect(poll).rejects.toThrow(
      "[ai] fal cannot poll without a valid API key.\n  Fix FAL_KEY; the next run adopts the same job."
    );
    await expect(poll).rejects.not.toHaveProperty("status");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    401, 403
  ])("keeps the job adoptable when fal refuses the key (HTTP %i)", async status => {
    stubFetch(jsonResponse(status, { detail: "bad key" }));
    const poll = pollQueueJob(
      createTestCtx(),
      encodeJobId(JOB),
      undefined,
      "fal:x:failed",
      collect
    );
    await expect(poll).rejects.toThrow("[ai] fal cannot poll without a valid API key.");
    await expect(poll).rejects.not.toHaveProperty("status");
  });
});

describe("runQueueJob", () => {
  it("waits for the job and collects it", async () => {
    stubFetch(
      jsonResponse(200, { status: "IN_PROGRESS" }),
      jsonResponse(200, { status: "COMPLETED" })
    );
    const result = await runQueueJob(
      createTestCtx(),
      encodeJobId(JOB),
      undefined,
      async (job, apiKey) => ({
        id: job.requestId,
        apiKey
      })
    );
    expect(result).toEqual({ id: "req-9", apiKey: TEST_KEY });
  });

  it("rejects a job id that is not a fal job id", async () => {
    await expect(runQueueJob(createTestCtx(), "nope", undefined, async () => 1)).rejects.toThrow(
      '[ai] fal job id "nope" is not valid.'
    );
  });

  it("surfaces a retryable wait error unchanged", async () => {
    stubFetch(
      jsonResponse(200, { status: "COMPLETED", error: "t", error_type: "generation_timeout" })
    );
    await expect(
      runQueueJob(createTestCtx(), encodeJobId(JOB), undefined, async () => 1)
    ).rejects.toBeInstanceOf(RetryableProviderError);
  });
});

describe("mimeFromUrl", () => {
  const byExtension = { png: "image/png", jpg: "image/jpeg", mp3: "audio/mpeg" };

  it.each([
    ["https://v3.fal.media/files/a.png", "image/png"],
    ["https://v3.fal.media/files/A.JPG?x=1", "image/jpeg"],
    ["https://v3.fal.media/files/track.mp3#t", "audio/mpeg"],
    ["https://v3.fal.media/files/noext", undefined],
    ["https://v3.fal.media/files/a.gif", undefined],
    ["not a url", undefined]
  ])("%s → %s", (url, mime) => {
    expect(mimeFromUrl(url, byExtension)).toBe(mime);
  });
});

describe("passthroughParameters", () => {
  it("copies params minus the consumed keys and never mutates the input", () => {
    const params = { resolution: "2K", quality: "low", seed: 7 };
    const copy = passthroughParameters(params, ["resolution", "quality"]);
    expect(copy).toEqual({ seed: 7 });
    expect(params).toEqual({ resolution: "2K", quality: "low", seed: 7 });
    expect(copy).not.toBe(params);
  });

  it("returns an empty object for no params", () => {
    expect(passthroughParameters(undefined, ["resolution"])).toEqual({});
  });
});
