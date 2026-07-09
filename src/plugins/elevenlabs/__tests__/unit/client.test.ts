import { afterEach, describe, expect, it, vi } from "vitest";
import type { ElevenlabsRequestOptions } from "../../client";
import { elevenlabsRequest } from "../../client";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "../../types";

/**
 * Builds a fake `Response` for a given status/body/headers — a partial
 * mock of a complex external (Fetch API) type (spec/09 R9's test-mock
 * allowlist), covering only the members `elevenlabsRequest` reads.
 */
function fakeResponse(options: {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  arrayBuffer?: ArrayBuffer;
}): Response {
  const headers = new Headers(options.headers ?? {});
  const fake = {
    ok: options.status < 400,
    status: options.status,
    headers,
    json: () => Promise.resolve(options.body),
    arrayBuffer: () => Promise.resolve(options.arrayBuffer ?? new ArrayBuffer(0))
  };
  return fake as unknown as Response;
}

/** Base request options shared by every test, overridden per case. */
const BASE_OPTIONS: ElevenlabsRequestOptions = {
  baseUrl: "https://api.elevenlabs.io",
  path: "/v1/text-to-speech/voice1",
  apiKey: "secret-key",
  body: { text: "hello", model_id: "eleven_multilingual_v2" },
  timeoutMs: 5000
};

/** Runs `elevenlabsRequest` and returns the thrown value (never resolves in these tests). */
async function captureRejection(options: ElevenlabsRequestOptions): Promise<unknown> {
  try {
    await elevenlabsRequest(options);
    throw new Error("expected elevenlabsRequest to reject");
  } catch (error) {
    return error;
  }
}

describe("elevenlabsRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to baseUrl+path with the xi-api-key header and a JSON body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        fakeResponse({ status: 200, arrayBuffer: new Uint8Array([1, 2, 3]).buffer })
      );
    vi.stubGlobal("fetch", fetchMock);

    const audio = await elevenlabsRequest(BASE_OPTIONS);

    expect(audio).toEqual(new Uint8Array([1, 2, 3]));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice1");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("secret-key");
    expect(JSON.parse(init.body as string)).toEqual(BASE_OPTIONS.body);
  });

  // ---------------------------------------------------------------------
  // Error classification table
  // ---------------------------------------------------------------------

  it("classifies HTTP 500 as RetryableProviderError with status 500", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse({ status: 500, body: {} })));

    const caught = await captureRejection(BASE_OPTIONS);

    expect(caught).toBeInstanceOf(RetryableProviderError);
    expect((caught as RetryableProviderError).status).toBe(500);
  });

  it("classifies HTTP 429 as RetryableProviderError, surfacing Retry-After as retryAfterMs", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(fakeResponse({ status: 429, body: {}, headers: { "retry-after": "2" } }))
    );

    const caught = await captureRejection(BASE_OPTIONS);

    expect(caught).toBeInstanceOf(RetryableProviderError);
    const error = caught as RetryableProviderError;
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(2000);
  });

  it("classifies a non-429 4xx as TerminalProviderError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse({ status: 400, body: {} })));

    const caught = await captureRejection(BASE_OPTIONS);

    expect(caught).toBeInstanceOf(TerminalProviderError);
    expect((caught as TerminalProviderError).status).toBe(400);
  });

  it("classifies a content-policy rejection (detail.status) as FlaggedProviderError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        fakeResponse({
          status: 400,
          body: { detail: { status: "content_policy_violation", message: "banned content" } }
        })
      )
    );

    const caught = await captureRejection(BASE_OPTIONS);

    expect(caught).toBeInstanceOf(FlaggedProviderError);
  });

  it("classifies a network failure (fetch rejects) as RetryableProviderError with kind network", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const caught = await captureRejection(BASE_OPTIONS);

    expect(caught).toBeInstanceOf(RetryableProviderError);
    expect((caught as RetryableProviderError).kind).toBe("network");
  });

  it("classifies a timeout as RetryableProviderError with kind timeout, honoring timeoutMs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation timed out.", "TimeoutError"));
          });
        });
      })
    );

    const caught = await captureRejection({ ...BASE_OPTIONS, timeoutMs: 10 });

    expect(caught).toBeInstanceOf(RetryableProviderError);
    expect((caught as RetryableProviderError).kind).toBe("timeout");
  });

  // ---------------------------------------------------------------------
  // Signal propagation — a caller abort cancels the in-flight fetch
  // ---------------------------------------------------------------------

  it("propagates a caller abort to fetch's signal (clean-pause propagation)", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        observedSignal = init.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      })
    );

    const requestPromise = elevenlabsRequest({ ...BASE_OPTIONS, signal: controller.signal });
    controller.abort();

    await expect(requestPromise).rejects.toThrow();
    expect(observedSignal?.aborted).toBe(true);
  });

  // ---------------------------------------------------------------------
  // Redaction — thrown messages never echo request text or response bodies
  // ---------------------------------------------------------------------

  it("never includes request text in a thrown error's message", async () => {
    const secretText = "SUPER SECRET REQUEST TEXT";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse({ status: 500, body: {} })));

    const caught = await captureRejection({ ...BASE_OPTIONS, body: { text: secretText } });

    expect((caught as Error).message).not.toContain(secretText);
  });

  it("never includes the response body's message in a thrown error's message", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          fakeResponse({ status: 400, body: { detail: { message: "LEAKED RESPONSE DETAIL" } } })
        )
    );

    const caught = await captureRejection(BASE_OPTIONS);

    expect((caught as Error).message).not.toContain("LEAKED RESPONSE DETAIL");
  });
});
