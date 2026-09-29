import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiRequest } from "../../client";
import { apiData, apiFetch, withRateLimitWait } from "../../client";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "../../types";
import {
  BASE,
  callsOf,
  envelope,
  jsonResponse,
  PROMPT,
  rejectionOf,
  stubFetch,
  TEST_KEY
} from "./fixtures";

const SUBMIT: ApiRequest = {
  url: `${BASE}/video/generations`,
  method: "POST",
  apiKey: TEST_KEY,
  json: { model: "seedance-2.5" },
  timeoutMs: 5000
};

/** Runs `apiFetch(request)` and returns what it threw. */
function failureOf(request: ApiRequest = SUBMIT): Promise<unknown> {
  return rejectionOf(() => apiFetch(request));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("apiFetch request shape", () => {
  it("POSTs JSON with the Bearer authorization header and returns status + body bytes", async () => {
    const fetchMock = stubFetch(jsonResponse(200, { ok: 1 }));

    const response = await apiFetch(SUBMIT);

    expect(response.status).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({ ok: 1 });
    const [call] = callsOf(fetchMock);
    expect(call?.url).toBe(`${BASE}/video/generations`);
    expect(call?.method).toBe("POST");
    expect(call?.headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(call?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(call?.body))).toEqual({ model: "seedance-2.5" });
  });

  it("sends no Authorization header without a key (result download)", async () => {
    const fetchMock = stubFetch(new Response(new Uint8Array([7, 8]), { status: 200 }));

    const response = await apiFetch({ url: "https://r2/clip.mp4", method: "GET", timeoutMs: 5000 });

    expect(response.body).toEqual(new Uint8Array([7, 8]));
    const [call] = callsOf(fetchMock);
    expect(call?.headers.Authorization).toBeUndefined();
    expect(call?.body).toBeUndefined();
  });

  it("sends a FormData body as is, leaving the multipart content type to fetch", async () => {
    const fetchMock = stubFetch(envelope({ publicUrl: "u" }));
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([1])], { type: "image/png" }), "a.png");

    await apiFetch({
      url: `${BASE}/files`,
      method: "POST",
      apiKey: TEST_KEY,
      form,
      timeoutMs: 5000
    });

    const [call] = callsOf(fetchMock);
    expect(call?.body).toBe(form);
    expect(call?.headers["content-type"]).toBeUndefined();
    expect(call?.headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
  });
});

describe("apiData envelope", () => {
  it("returns data of a code-200 envelope", async () => {
    stubFetch(envelope({ taskId: "task-1", state: "pending" }));
    expect(await apiData(SUBMIT, "submit response")).toEqual({
      taskId: "task-1",
      state: "pending"
    });
  });

  it("returns data when the envelope has no code", async () => {
    stubFetch(jsonResponse(200, { data: { id: "grp-1" } }));
    expect(await apiData(SUBMIT, "group response")).toEqual({ id: "grp-1" });
  });

  it.each([
    [500, RetryableProviderError],
    [503, RetryableProviderError],
    [401, TerminalProviderError],
    [404, TerminalProviderError]
  ])("reads envelope code %d on an HTTP 200 like the HTTP status", async (code, errorClass) => {
    stubFetch(envelope(undefined, code));
    const error = await rejectionOf(() => apiData(SUBMIT, "submit response"));
    expect(error).toBeInstanceOf(errorClass);
    expect((error as { status: number }).status).toBe(code);
  });

  it("reads envelope code 429 as rate-limited, with the Retry-After header", async () => {
    stubFetch(jsonResponse(200, { code: 429, msg: "slow down" }, { "retry-after": "2" }));
    const error = await rejectionOf(() => apiData(SUBMIT, "submit response"));
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 2000 });
  });

  it("an unreadable JSON body is retryable (502)", async () => {
    stubFetch(new Response("<html>oops</html>", { status: 200 }));
    const error = await rejectionOf(() => apiData(SUBMIT, "submit response"));
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ status: 502 });
    expect((error as Error).message).toBe(
      "[ai] apimodels returned an unreadable submit response.\n  Expected JSON (HTTP 200); the runner retries it."
    );
  });
});

describe("apiFetch classification table", () => {
  it("401 with a key is terminal and names the key env var", async () => {
    stubFetch(jsonResponse(401, { code: 401, msg: "Unauthorized" }));
    const error = await failureOf();
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({ status: 401 });
    expect((error as Error).message).toBe(
      "[ai] apimodels rejected the API key (HTTP 401).\n  Check APIMODELS_API_KEY, or the env var named by apimodels.apiKeyEnv."
    );
  });

  it("403 with a key is terminal", async () => {
    stubFetch(jsonResponse(403, {}));
    expect(await failureOf()).toMatchObject({ status: 403, name: "TerminalProviderError" });
  });

  it("402 is terminal: balance too low", async () => {
    stubFetch(jsonResponse(402, { code: 402, msg: "Insufficient balance" }));
    const error = await failureOf();
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toBe(
      "[ai] apimodels balance is too low (HTTP 402).\n  Top up the apimodels account, then run again."
    );
  });

  it("422 on a moderated call (asset registration) is flagged", async () => {
    stubFetch(jsonResponse(422, { code: 422, msg: "Face not allowed." }));
    const error = await failureOf({ ...SUBMIT, url: `${BASE}/assets`, moderated: true });
    expect(error).toBeInstanceOf(FlaggedProviderError);
    expect((error as Error).message).toBe(
      "[ai] apimodels flagged the asset (HTTP 422): Face not allowed.\n  Use another image, or remove it from params.assets; nothing was charged."
    );
  });

  it("422 on any other call is terminal", async () => {
    stubFetch(jsonResponse(422, { code: 422, msg: "bad field" }));
    const error = await failureOf();
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({ status: 422 });
  });

  it("another 4xx is terminal and keeps apimodels' failCode and text", async () => {
    stubFetch(
      jsonResponse(400, {
        code: 400,
        msg: "invalid",
        data: { failCode: "INVALID_INPUT", failMsg: "asset expired" }
      })
    );
    const error = await failureOf();
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({
      status: 400,
      failCode: "INVALID_INPUT",
      detail: "asset expired"
    });
    expect((error as Error).message).toBe(
      "[ai] apimodels rejected the request (HTTP 400): asset expired.\n  Check the request fields against the apimodels docs."
    );
  });

  it("a failCode CONTENT_MODERATION is flagged on any call", async () => {
    stubFetch(
      jsonResponse(400, { code: 400, data: { failCode: "CONTENT_MODERATION", failMsg: "nsfw" } })
    );
    const error = await failureOf();
    expect(error).toBeInstanceOf(FlaggedProviderError);
    expect((error as Error).message).toBe(
      "[ai] apimodels flagged the request (content moderation): nsfw.\n  Change the prompt or the inputs."
    );
  });

  it("429 is retryable with Retry-After in seconds", async () => {
    stubFetch(jsonResponse(429, {}, { "retry-after": "3" }));
    const error = await failureOf();
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 3000 });
    expect((error as Error).message).toBe(
      "[ai] apimodels rate-limited the request (HTTP 429).\n  The runner retries after Retry-After."
    );
  });

  it("429 is retryable with Retry-After as an HTTP date", async () => {
    stubFetch(jsonResponse(429, {}, { "retry-after": new Date(Date.now() + 5000).toUTCString() }));
    const error = (await failureOf()) as RetryableProviderError;
    expect(error.retryAfterMs).toBeGreaterThan(3000);
    expect(error.retryAfterMs).toBeLessThanOrEqual(5000);
  });

  it("429 without a readable Retry-After has no hint", async () => {
    stubFetch(jsonResponse(429, {}, { "retry-after": "soon" }));
    expect(await failureOf()).toMatchObject({ status: 429, retryAfterMs: undefined });
  });

  it("5xx is retryable with its status", async () => {
    stubFetch(jsonResponse(500, { code: 500, msg: "boom" }));
    const error = await failureOf();
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ status: 500, kind: undefined });
    expect((error as Error).message).toBe(
      "[ai] apimodels returned HTTP 500.\n  The runner retries it."
    );
  });

  it("a request timeout is retryable, kind timeout", async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const error = await failureOf({ ...SUBMIT, timeoutMs: 10 });
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ kind: "timeout", status: undefined });
    expect((error as Error).message).toBe(
      "[ai] apimodels request timed out.\n  The runner retries it; raise apimodels.timeoutMs for large files."
    );
  });

  it("a fetch TypeError is retryable, kind network", async () => {
    stubFetch(new TypeError("fetch failed"));
    const error = await failureOf();
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ kind: "network" });
    expect((error as Error).message).toBe(
      "[ai] apimodels request failed (network).\n  The runner retries it."
    );
  });

  it("a caller abort is rethrown unchanged", async () => {
    const reason = new Error("paused");
    stubFetch(reason);
    const controller = new AbortController();
    controller.abort(reason);
    expect(await failureOf({ ...SUBMIT, signal: controller.signal })).toBe(reason);
  });

  it("messages never contain the key, even when apimodels echoes it", async () => {
    stubFetch(jsonResponse(400, { code: 400, msg: `bad header Bearer ${TEST_KEY}` }));
    const error = (await failureOf()) as TerminalProviderError;
    expect(error.message).not.toContain(TEST_KEY);
    expect(error.detail).not.toContain(TEST_KEY);
    expect(error.message).toContain("[redacted]");
  });

  it("messages never contain a string the caller asked to redact (the prompt)", async () => {
    stubFetch(jsonResponse(400, { code: 400, msg: `prompt too long: ${PROMPT}` }));
    const error = await failureOf({ ...SUBMIT, redact: [PROMPT] });
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).not.toContain(PROMPT);
    expect((error as Error).message).toContain("prompt too long: [redacted]");
  });

  it("cuts long upstream text to 300 characters", async () => {
    stubFetch(jsonResponse(400, { code: 400, msg: "x".repeat(1000) }));
    const error = (await failureOf()) as TerminalProviderError;
    expect(error.detail).toBe(`${"x".repeat(300)}...`);
  });
});

/** A 429 as the client throws it. */
function rateLimited(retryAfterMs: number | undefined): RetryableProviderError {
  return new RetryableProviderError("[ai] apimodels rate-limited the request (HTTP 429).\n  x.", {
    status: 429,
    retryAfterMs
  });
}

describe("withRateLimitWait", () => {
  it("waits Retry-After once after a 429, then calls again", async () => {
    const call = vi.fn().mockRejectedValueOnce(rateLimited(5)).mockResolvedValueOnce("ok");
    expect(await withRateLimitWait(call, 1000)).toBe("ok");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("throws the second 429", async () => {
    const second = rateLimited(1);
    const call = vi.fn().mockRejectedValueOnce(rateLimited(1)).mockRejectedValueOnce(second);
    expect(await rejectionOf(() => withRateLimitWait(call, 1000))).toBe(second);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("throws any other error at once", async () => {
    const error = new RetryableProviderError("[ai] x.\n  y.", { status: 503 });
    const call = vi.fn().mockRejectedValue(error);
    expect(await rejectionOf(() => withRateLimitWait(call, 1000))).toBe(error);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("caps the wait at capMs", async () => {
    const call = vi.fn().mockRejectedValueOnce(rateLimited(60_000)).mockResolvedValueOnce("ok");
    const started = Date.now();
    expect(await withRateLimitWait(call, 20)).toBe("ok");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("stops waiting when the caller aborts", async () => {
    const controller = new AbortController();
    const reason = new Error("paused");
    const call = vi.fn().mockImplementationOnce(async () => {
      setTimeout(() => controller.abort(reason), 5);
      throw rateLimited(60_000);
    });
    expect(await rejectionOf(() => withRateLimitWait(call, 60_000, controller.signal))).toBe(
      reason
    );
    expect(call).toHaveBeenCalledTimes(1);
  });
});
