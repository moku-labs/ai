import { describe, expect, it } from "vitest";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "../../errors";

describe("openai unit: errors", () => {
  it("RetryableProviderError without a hint leaves every hint field undefined", () => {
    const error = new RetryableProviderError("[ai] OpenAI request failed (network error).");

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("[ai] OpenAI request failed (network error).");
    expect(error.status).toBeUndefined();
    expect(error.kind).toBeUndefined();
    expect(error.retryAfterMs).toBeUndefined();
  });

  it("RetryableProviderError copies status, kind and retryAfterMs from the hint", () => {
    const error = new RetryableProviderError("[ai] OpenAI rate limited the request.", {
      status: 429,
      kind: "network",
      retryAfterMs: 1000
    });

    expect(error.status).toBe(429);
    expect(error.kind).toBe("network");
    expect(error.retryAfterMs).toBe(1000);
  });

  it("TerminalProviderError carries the HTTP status, or undefined without one", () => {
    const withStatus = new TerminalProviderError("[ai] OpenAI rejected the request (400).", 400);
    const withoutStatus = new TerminalProviderError("[ai] OpenAI returned no completion choices.");

    expect(withStatus).toBeInstanceOf(Error);
    expect(withStatus.status).toBe(400);
    expect(withoutStatus.status).toBeUndefined();
  });

  it("FlaggedProviderError is tagged with the content-policy kind", () => {
    const error = new FlaggedProviderError("[ai] OpenAI declined the request (content policy).");

    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe("content-policy");
  });
});
