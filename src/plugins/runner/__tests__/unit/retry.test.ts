import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ErrorClass } from "../../../journal/types";
import { backoffMs, classifyError, isRetryableErrorClass, retryAfterMsOf } from "../../retry";

// ---------------------------------------------------------------------------
// classifyError — the retry taxonomy classification table
// ---------------------------------------------------------------------------

describe("classifyError", () => {
  it("classifies a 5xx status as http-5xx", () => {
    expect(classifyError(Object.assign(new Error("boom"), { status: 502 }))).toBe("http-5xx");
  });

  it("classifies a 429 status as http-429 (not the general 4xx bucket)", () => {
    expect(classifyError(Object.assign(new Error("rate limited"), { status: 429 }))).toBe(
      "http-429"
    );
  });

  it("classifies a non-429 4xx status as http-4xx", () => {
    expect(classifyError(Object.assign(new Error("bad request"), { status: 400 }))).toBe(
      "http-4xx"
    );
  });

  it("classifies a kind:timeout hint as timeout", () => {
    expect(classifyError(Object.assign(new Error("timed out"), { kind: "timeout" }))).toBe(
      "timeout"
    );
  });

  it("classifies a kind:content-policy hint as content-policy, even with a status present", () => {
    const error = Object.assign(new Error("flagged"), { kind: "content-policy", status: 400 });
    expect(classifyError(error)).toBe("content-policy");
  });

  it("classifies a kind:network hint as network", () => {
    expect(classifyError(Object.assign(new Error("dns failure"), { kind: "network" }))).toBe(
      "network"
    );
  });

  it("classifies a plain Error with no hint as unknown (terminal, never retried)", () => {
    expect(classifyError(new Error("mystery failure"))).toBe("unknown");
    expect(classifyError(new TypeError("x is not a function"))).toBe("unknown");
  });

  it("classifies a non-object thrown value as unknown", () => {
    expect(classifyError("just a string")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// retryAfterMsOf
// ---------------------------------------------------------------------------

describe("retryAfterMsOf", () => {
  it("reads a Retry-After hint off the error", () => {
    const error = Object.assign(new Error("rate limited"), { status: 429, retryAfterMs: 5000 });
    expect(retryAfterMsOf(error)).toBe(5000);
  });

  it("returns undefined when no hint is attached", () => {
    expect(retryAfterMsOf(new Error("boom"))).toBeUndefined();
  });

  it("returns undefined for a non-object thrown value", () => {
    expect(retryAfterMsOf(42)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isRetryableErrorClass
// ---------------------------------------------------------------------------

describe("isRetryableErrorClass", () => {
  const retryableClasses: ErrorClass[] = ["http-5xx", "http-429", "timeout", "network"];
  const terminalClasses: ErrorClass[] = ["http-4xx", "content-policy", "unknown"];

  it.each(retryableClasses)("treats %s as retryable", errorClass => {
    expect(isRetryableErrorClass(errorClass)).toBe(true);
  });

  it.each(terminalClasses)("treats %s as terminal (not retryable)", errorClass => {
    expect(isRetryableErrorClass(errorClass)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// backoffMs — exponential growth, jitter bounds, Retry-After precedence
// ---------------------------------------------------------------------------

describe("backoffMs", () => {
  const MIN_JITTER_FACTOR = 0.5;
  const MAX_JITTER_FACTOR = 0.999_999;

  beforeEach(() => {
    vi.spyOn(Math, "random");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("grows exponentially with the attempt number, at minimum jitter", () => {
    vi.mocked(Math.random).mockReturnValue(0);

    expect(backoffMs(1, 1000)).toBe(1000 * MIN_JITTER_FACTOR);
    expect(backoffMs(2, 1000)).toBe(2000 * MIN_JITTER_FACTOR);
    expect(backoffMs(3, 1000)).toBe(4000 * MIN_JITTER_FACTOR);
  });

  it("never exceeds the un-jittered exponential value, at maximum jitter", () => {
    vi.mocked(Math.random).mockReturnValue(MAX_JITTER_FACTOR);

    const delay = backoffMs(2, 1000);
    expect(delay).toBeLessThanOrEqual(2000);
    expect(delay).toBeGreaterThan(1000);
  });

  it("honors Retry-After when it is larger than the computed backoff", () => {
    vi.mocked(Math.random).mockReturnValue(0);

    expect(backoffMs(1, 1000, 10_000)).toBe(10_000);
  });

  it("ignores Retry-After when it is smaller than the computed backoff", () => {
    vi.mocked(Math.random).mockReturnValue(MAX_JITTER_FACTOR);

    const delay = backoffMs(3, 1000, 1);
    expect(delay).toBeGreaterThan(1);
  });

  it("ignores an undefined Retry-After", () => {
    vi.mocked(Math.random).mockReturnValue(0);

    expect(backoffMs(1, 1000, undefined)).toBe(500);
  });
});
