import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  RateLimitError
} from "openai";
import { describe, expect, it } from "vitest";
import {
  classifyOpenaiError,
  getOpenaiClient,
  missingApiKeyError,
  requestChatCompletion,
  requestSpeech,
  toOpenaiCallOptions
} from "../../client";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "../../types";
import { createFakeOpenaiClient, createFakeOpenaiContext } from "./fixtures";

describe("openai unit: client", () => {
  describe("missingApiKeyError", () => {
    it("returns the exact pinned two-line message, interpolating apiKeyEnv", () => {
      const error = missingApiKeyError("OPENAI_API_KEY");

      expect(error.message).toBe(
        "[ai] OPENAI_API_KEY is not set.\n  Export it or set config.apiKeyEnv to the variable that holds your key."
      );
    });

    it("interpolates a custom apiKeyEnv name", () => {
      const error = missingApiKeyError("MY_CUSTOM_KEY");

      expect(error.message).toBe(
        "[ai] MY_CUSTOM_KEY is not set.\n  Export it or set config.apiKeyEnv to the variable that holds your key."
      );
    });
  });

  describe("getOpenaiClient", () => {
    it("throws the pinned missing-key error when the env var is unset", () => {
      const ctx = createFakeOpenaiContext();

      expect(() => getOpenaiClient(ctx)).toThrow(
        "[ai] OPENAI_API_KEY is not set.\n  Export it or set config.apiKeyEnv to the variable that holds your key."
      );
    });

    it("returns the cached client without re-reading the env when state.client is pre-seeded", () => {
      const { client: fakeClient } = createFakeOpenaiClient();
      const ctx = createFakeOpenaiContext({ state: { client: fakeClient } });

      const resolved = getOpenaiClient(ctx);

      expect(resolved).toBe(fakeClient);
    });

    it("lazily constructs a client once the API key is present, and caches it", () => {
      const ctx = createFakeOpenaiContext({ apiKey: "sk-test" });

      const first = getOpenaiClient(ctx);
      const second = getOpenaiClient(ctx);

      expect(first).toBe(second);
      expect(ctx.state.client).toBe(first);
    });
  });

  describe("toOpenaiCallOptions", () => {
    it("omits the signal key entirely when no signal is given", () => {
      expect(toOpenaiCallOptions(undefined)).toEqual({});
      expect(Object.hasOwn(toOpenaiCallOptions(undefined), "signal")).toBe(false);
    });

    it("includes the signal when given", () => {
      const controller = new AbortController();

      expect(toOpenaiCallOptions(controller.signal)).toEqual({ signal: controller.signal });
    });
  });

  describe("classifyOpenaiError — error classification table", () => {
    it("classifies APIConnectionTimeoutError as retryable/timeout", () => {
      const classified = classifyOpenaiError(new APIConnectionTimeoutError());

      expect(classified).toBeInstanceOf(RetryableProviderError);
      expect((classified as RetryableProviderError).kind).toBe("timeout");
    });

    it("classifies a generic connection error as retryable/network", () => {
      const classified = classifyOpenaiError(new APIConnectionError({ message: "boom" }));

      expect(classified).toBeInstanceOf(RetryableProviderError);
      expect((classified as RetryableProviderError).kind).toBe("network");
    });

    it("classifies a non-object thrown value as retryable/network", () => {
      const classified = classifyOpenaiError("boom");

      expect(classified).toBeInstanceOf(RetryableProviderError);
      expect((classified as RetryableProviderError).kind).toBe("network");
    });

    it("classifies a 429 as retryable/http-429 with retryAfterMs from the header", () => {
      const error = new RateLimitError(
        429,
        { code: "rate_limit_exceeded" },
        "Rate limited",
        new Headers({ "retry-after": "2" })
      );

      const classified = classifyOpenaiError(error);

      expect(classified).toBeInstanceOf(RetryableProviderError);
      const retryable = classified as RetryableProviderError;
      expect(retryable.status).toBe(429);
      expect(retryable.retryAfterMs).toBe(2000);
    });

    it("classifies a 5xx as retryable/http-5xx", () => {
      const error = new APIError(503, {}, "Service unavailable", new Headers());

      const classified = classifyOpenaiError(error);

      expect(classified).toBeInstanceOf(RetryableProviderError);
      expect((classified as RetryableProviderError).status).toBe(503);
    });

    it("classifies a content-policy 400 as flagged, never retryable", () => {
      const error = new APIError(
        400,
        { code: "content_policy_violation" },
        "Your request was rejected",
        new Headers()
      );

      const classified = classifyOpenaiError(error);

      expect(classified).toBeInstanceOf(FlaggedProviderError);
    });

    it("classifies a plain 4xx (not content-policy, not 429) as terminal", () => {
      const error = new APIError(
        400,
        { code: "invalid_request_error" },
        "Bad request",
        new Headers()
      );

      const classified = classifyOpenaiError(error);

      expect(classified).toBeInstanceOf(TerminalProviderError);
      expect((classified as TerminalProviderError).status).toBe(400);
    });

    it("never echoes the caught error's own message (redaction)", () => {
      const error = new APIError(
        400,
        { code: "invalid_request_error" },
        "SECRET_PROMPT_TEXT_SHOULD_NOT_LEAK",
        new Headers()
      );

      const classified = classifyOpenaiError(error);

      expect(classified.message).not.toContain("SECRET_PROMPT_TEXT_SHOULD_NOT_LEAK");
    });

    it("returns a caller-initiated APIUserAbortError unchanged — never retryable (clean pause)", () => {
      const abortError = new APIUserAbortError();

      const classified = classifyOpenaiError(abortError);

      expect(classified).toBe(abortError);
      expect(classified).not.toBeInstanceOf(RetryableProviderError);
    });

    it("parses an HTTP-date Retry-After header into a delay from now", () => {
      const retryAtMs = Date.now() + 30_000;
      const error = new RateLimitError(
        429,
        { code: "rate_limit_exceeded" },
        "Rate limited",
        new Headers({ "retry-after": new Date(retryAtMs).toUTCString() })
      );

      const classified = classifyOpenaiError(error);

      expect(classified).toBeInstanceOf(RetryableProviderError);
      const retryable = classified as RetryableProviderError;
      expect(retryable.retryAfterMs).toBeGreaterThan(0);
      // toUTCString truncates to whole seconds — allow that plus test runtime.
      expect(retryable.retryAfterMs).toBeLessThanOrEqual(30_000);
    });
  });

  describe("requestChatCompletion / requestSpeech — pre-seeded fake client", () => {
    it("requestChatCompletion resolves with the fake client's result and forwards the signal", async () => {
      const { client, chatCalls } = createFakeOpenaiClient();
      const ctx = createFakeOpenaiContext({ state: { client } });
      const controller = new AbortController();

      const result = await requestChatCompletion(
        ctx,
        { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
        controller.signal
      );

      expect(result.choices[0]?.message.content).toBe("ok");
      expect(chatCalls[0]?.signal).toBe(controller.signal);
    });

    it("requestSpeech resolves with the fake client's result and forwards the signal", async () => {
      const { client, speechCalls } = createFakeOpenaiClient();
      const ctx = createFakeOpenaiContext({ state: { client } });
      const controller = new AbortController();

      const response = await requestSpeech(
        ctx,
        { model: "gpt-4o-mini-tts", voice: "alloy", input: "hi" },
        controller.signal
      );

      await expect(response.arrayBuffer()).resolves.toBeInstanceOf(ArrayBuffer);
      expect(speechCalls[0]?.signal).toBe(controller.signal);
    });

    it("requestChatCompletion classifies a thrown SDK error onto the provider taxonomy", async () => {
      const { client } = createFakeOpenaiClient({
        chatImpl: async () => {
          throw new RateLimitError(429, {}, "Rate limited", new Headers());
        }
      });
      const ctx = createFakeOpenaiContext({ state: { client } });

      await expect(
        requestChatCompletion(ctx, { model: "gpt-4o-mini", messages: [] }, undefined)
      ).rejects.toBeInstanceOf(RetryableProviderError);
    });

    it("requestChatCompletion rethrows the original error unchanged when the caller's signal aborted", async () => {
      const abortError = new APIUserAbortError();
      const { client } = createFakeOpenaiClient({
        chatImpl: async () => {
          throw abortError;
        }
      });
      const ctx = createFakeOpenaiContext({ state: { client } });
      const controller = new AbortController();
      controller.abort();

      await expect(
        requestChatCompletion(ctx, { model: "gpt-4o-mini", messages: [] }, controller.signal)
      ).rejects.toBe(abortError);
    });

    it("requestSpeech rethrows the original error unchanged when the caller's signal aborted", async () => {
      const abortError = new APIUserAbortError();
      const { client } = createFakeOpenaiClient({
        speechImpl: async () => {
          throw abortError;
        }
      });
      const ctx = createFakeOpenaiContext({ state: { client } });
      const controller = new AbortController();
      controller.abort();

      await expect(
        requestSpeech(
          ctx,
          { model: "gpt-4o-mini-tts", voice: "alloy", input: "hi" },
          controller.signal
        )
      ).rejects.toBe(abortError);
    });
  });
});
