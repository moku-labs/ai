import { describe, expect, it } from "vitest";
import {
  FlaggedProviderError,
  LocalFailureError,
  RetryableProviderError,
  TerminalProviderError
} from "../../errors";
import { redactedFailureOf, resolveApiKey } from "../../support";
import { createFakeEnv, createTestCtx } from "./fixtures";

describe("redactedFailureOf", () => {
  it("keeps status and kind of a retryable error", () => {
    const error = new RetryableProviderError("[ai] ElevenLabs request timed out.", {
      kind: "timeout"
    });

    expect(redactedFailureOf(error)).toEqual({ errorType: "retryable", kind: "timeout" });
  });

  it("keeps the status of a terminal error", () => {
    const error = new TerminalProviderError(
      "[ai] ElevenLabs rejected the request (HTTP 400).",
      400
    );

    expect(redactedFailureOf(error)).toEqual({ errorType: "terminal", status: 400 });
  });

  it("keeps the kind of a flagged error", () => {
    const error = new FlaggedProviderError("[ai] ElevenLabs rejected the request.");

    expect(redactedFailureOf(error)).toEqual({ errorType: "flagged", kind: "content-policy" });
  });

  it("names a local failure (a dialogue cut) instead of logging it as unknown", () => {
    const error = new LocalFailureError("[ai] Could not cut the ElevenLabs dialogue audio.\n  x.");

    expect(redactedFailureOf(error)).toEqual({ errorType: "local-failure", kind: "local-failure" });
  });

  it("drops everything from an unknown error, including its message", () => {
    expect(redactedFailureOf(new Error("SECRET"))).toEqual({ errorType: "unknown" });
  });
});

describe("resolveApiKey", () => {
  it("returns the key from the configured env var", () => {
    const ctx = createTestCtx({ env: createFakeEnv({ ELEVENLABS_API_KEY: "test-key" }) });

    expect(resolveApiKey(ctx)).toBe("test-key");
  });

  it("throws the pinned two-line error when the env var is unset", () => {
    expect(() => resolveApiKey(createTestCtx())).toThrow(
      "[ai] ELEVENLABS_API_KEY is not set.\n  Export it or set config.apiKeyEnv to the variable that holds your key."
    );
  });
});
