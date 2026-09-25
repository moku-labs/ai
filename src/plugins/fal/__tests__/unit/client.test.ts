import { afterEach, describe, expect, it, vi } from "vitest";
import type { FalRequest } from "../../client";
import { falFetch, jobFailure, parseJson } from "../../client";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "../../types";
import { callsOf, jsonResponse, stubFetch, TEST_KEY } from "./fixtures";

const BASE: FalRequest = {
  url: "https://queue.fal.run/minimax/h3/image-to-video",
  method: "POST",
  apiKey: TEST_KEY,
  json: { prompt: "p" },
  timeoutMs: 5000
};

/** Runs `falFetch` and returns what it threw. */
async function rejectionOf(request: FalRequest = BASE): Promise<unknown> {
  try {
    await falFetch(request);
  } catch (error) {
    return error;
  }
  throw new Error("expected falFetch to reject");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("falFetch request shape", () => {
  it("POSTs JSON with the Key authorization header and returns status + body bytes", async () => {
    const fetchMock = stubFetch(jsonResponse(200, { ok: 1 }));

    const response = await falFetch(BASE);

    expect(response.status).toBe(200);
    expect(parseJson(response, "test")).toEqual({ ok: 1 });
    const [call] = callsOf(fetchMock);
    expect(call?.url).toBe(BASE.url);
    expect(call?.method).toBe("POST");
    expect(call?.headers.Authorization).toBe(`Key ${TEST_KEY}`);
    expect(call?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(call?.body))).toEqual({ prompt: "p" });
  });

  it("sends no Authorization header when no key is given (CDN download)", async () => {
    const fetchMock = stubFetch(new Response(new Uint8Array([7, 8]), { status: 200 }));

    const response = await falFetch({ url: "https://cdn/v.mp4", method: "GET", timeoutMs: 5000 });

    expect(response.body).toEqual(new Uint8Array([7, 8]));
    const [call] = callsOf(fetchMock);
    expect(call?.method).toBe("GET");
    expect(call?.headers.Authorization).toBeUndefined();
    expect(call?.body).toBeUndefined();
  });

  it("PUTs raw bytes with the given content type", async () => {
    const fetchMock = stubFetch(new Response("", { status: 200 }));
    const bytes = new Uint8Array([1, 2, 3]);

    await falFetch({
      url: "https://upload/put",
      method: "PUT",
      bytes,
      contentType: "image/png",
      timeoutMs: 5000
    });

    const [call] = callsOf(fetchMock);
    expect(call?.method).toBe("PUT");
    expect(call?.headers["content-type"]).toBe("image/png");
    expect(call?.body).toEqual(bytes);
  });
});

describe("falFetch classification table", () => {
  it("5xx is retryable with its status", async () => {
    stubFetch(jsonResponse(500, { detail: "boom", error_type: "internal_server_error" }));
    const error = await rejectionOf();
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect((error as RetryableProviderError).status).toBe(500);
    expect((error as Error).message).toMatch(/^\[ai\] fal /);
  });

  it("429 is retryable with retryAfterMs from the retry-after header", async () => {
    stubFetch(jsonResponse(429, {}, { "retry-after": "3" }));
    const error = (await rejectionOf()) as RetryableProviderError;
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(3000);
  });

  it("429 without a usable retry-after carries no delay", async () => {
    stubFetch(jsonResponse(429, {}, { "retry-after": "soon" }));
    const error = (await rejectionOf()) as RetryableProviderError;
    expect(error.retryAfterMs).toBeUndefined();
  });

  it("429 with an HTTP-date retry-after becomes a non-negative delay", async () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    stubFetch(jsonResponse(429, {}, { "retry-after": future }));
    const error = (await rejectionOf()) as RetryableProviderError;
    expect(error.retryAfterMs).toBeGreaterThan(0);
  });

  it("422 with detail[].type content_policy_violation is flagged", async () => {
    stubFetch(
      jsonResponse(422, {
        detail: [{ loc: ["body", "prompt"], msg: "flagged", type: "content_policy_violation" }]
      })
    );
    const error = await rejectionOf();
    expect(error).toBeInstanceOf(FlaggedProviderError);
    expect((error as FlaggedProviderError).kind).toBe("content-policy");
  });

  it("an error_type containing content_policy is flagged", async () => {
    stubFetch(jsonResponse(400, { detail: "no", error_type: "content_policy_violation" }));
    expect(await rejectionOf()).toBeInstanceOf(FlaggedProviderError);
  });

  it("other 4xx is terminal with its status and fal's message", async () => {
    stubFetch(
      jsonResponse(422, {
        detail: [{ loc: ["body", "duration"], msg: "must be 3..15", type: "value_error" }]
      })
    );
    const error = (await rejectionOf()) as TerminalProviderError;
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error.status).toBe(422);
    expect(error.message).toContain("must be 3..15");
    expect(error.message).not.toContain(TEST_KEY);
  });

  it("401 is terminal", async () => {
    stubFetch(jsonResponse(401, { detail: "Unauthorized" }));
    const error = (await rejectionOf()) as TerminalProviderError;
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error.status).toBe(401);
  });

  it("a non-JSON error body still classifies by status", async () => {
    stubFetch(new Response("<html>bad gateway</html>", { status: 502 }));
    const error = (await rejectionOf()) as RetryableProviderError;
    expect(error.status).toBe(502);
  });

  it("truncates fal's error text to 300 characters", async () => {
    stubFetch(jsonResponse(400, { detail: "x".repeat(1000) }));
    const error = (await rejectionOf()) as TerminalProviderError;
    expect(error.message.length).toBeLessThan(400);
    expect(error.message).toContain("x".repeat(300));
    expect(error.message).not.toContain("x".repeat(301));
  });

  it("a fetch rejection is retryable kind network", async () => {
    stubFetch(new TypeError("fetch failed"));
    const error = (await rejectionOf()) as RetryableProviderError;
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error.kind).toBe("network");
  });

  it("a timeout is retryable kind timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation timed out.", "TimeoutError"));
          });
        });
      })
    );
    const error = (await rejectionOf({ ...BASE, timeoutMs: 5 })) as RetryableProviderError;
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error.kind).toBe("timeout");
  });

  it("a body that fails mid-read is retryable kind network", async () => {
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError("socket closed"));
        }
      }),
      { status: 200 }
    );
    stubFetch(broken);
    const error = (await rejectionOf()) as RetryableProviderError;
    expect(error.kind).toBe("network");
  });
});

describe("falFetch caller abort", () => {
  it("rethrows the caller's abort unchanged and aborts fetch's signal", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const abortError = new DOMException("paused", "AbortError");
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        seen = init.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(abortError));
        });
      })
    );

    const pending = rejectionOf({ ...BASE, signal: controller.signal });
    controller.abort();

    expect(await pending).toBe(abortError);
    expect(seen?.aborted).toBe(true);
  });
});

describe("parseJson", () => {
  it("throws a plain [ai] Error for a malformed body", () => {
    const response = { status: 200, headers: new Headers(), body: new TextEncoder().encode("{x") };
    expect(() => parseJson(response, "submit response")).toThrow(
      /^\[ai\] fal returned an unreadable submit response\./
    );
  });
});

describe("content-policy words in fal's text", () => {
  it.each([
    "The image contains sensitive content.",
    "Real-person LIKENESS is not allowed.",
    "NSFW content detected",
    "Rejected by Moderation."
  ])("an HTTP error with text %j is flagged", async text => {
    stubFetch(jsonResponse(400, { detail: text }));
    const error = await rejectionOf();
    expect(error).toBeInstanceOf(FlaggedProviderError);
    expect((error as FlaggedProviderError).kind).toBe("content-policy");
  });

  it("a finished job whose error names moderation is flagged", () => {
    const error = jobFailure({ status: "COMPLETED", error: "Output blocked by moderation" });
    expect(error).toBeInstanceOf(FlaggedProviderError);
  });

  it("unrelated text stays terminal", async () => {
    stubFetch(jsonResponse(400, { detail: "duration must be one of 4s, 6s, 8s" }));
    const error = await rejectionOf();
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).not.toBeInstanceOf(FlaggedProviderError);
  });

  it("an error with no text stays terminal", async () => {
    stubFetch(jsonResponse(400, {}));
    expect(await rejectionOf()).toBeInstanceOf(TerminalProviderError);
  });
});
