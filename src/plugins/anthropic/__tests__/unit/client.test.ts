/**
 * @file anthropic client — the error table (one test per row), the missing
 * key, the lazy client, the request boundary, redaction.
 */
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  InternalServerError,
  RateLimitError
} from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { isPromptGenUnavailable, PromptGenUnavailableError } from "../../../promptGen/contract";
import {
  classifyAnthropicError,
  getAnthropicClient,
  redactedFailureOf,
  requestMessage
} from "../../client";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "../../errors";
import type { AnthropicRequestBody } from "../../types";
import { createFakeAnthropicClient, createFakeAnthropicContext, textAnswer } from "./fixtures";

/** Text that must never reach an error message: the SDK message may quote the request. */
const SECRET = "SECRET-PROMPT-TEXT";

/**
 * An SDK `APIError` of `status`, with headers.
 *
 * @param status - HTTP status.
 * @param headers - Response headers.
 * @returns The error.
 */
function apiError(status: number, headers: Record<string, string> = {}): APIError {
  return APIError.generate(status, { error: { message: SECRET } }, SECRET, new Headers(headers));
}

const BODY: AnthropicRequestBody = {
  model: "claude-opus-5-5",
  max_tokens: 100,
  messages: [{ role: "user", content: "hi" }],
  output_config: { effort: "medium" }
};

describe("anthropic client: error table", () => {
  it("returns a caller abort unchanged", () => {
    const abort = new APIUserAbortError();

    expect(classifyAnthropicError(abort)).toBe(abort);
  });

  it("classifies a connection timeout as retryable timeout", () => {
    const error = classifyAnthropicError(new APIConnectionTimeoutError());

    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ kind: "timeout", status: undefined });
  });

  it("classifies a 429 as retryable with the Retry-After delay in ms", () => {
    const error = classifyAnthropicError(apiError(429, { "retry-after": "2" }));

    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 2000 });
  });

  it("reads an HTTP-date Retry-After as a delay from now", () => {
    const later = new Date(Date.now() + 60_000).toUTCString();

    const error = classifyAnthropicError(apiError(429, { "retry-after": later }));

    expect((error as RetryableProviderError).retryAfterMs).toBeGreaterThan(50_000);
  });

  it("classifies a 429 without Retry-After as retryable with no delay", () => {
    const error = classifyAnthropicError(apiError(429));

    expect(error).toMatchObject({ status: 429, retryAfterMs: undefined });
    expect(apiError(429)).toBeInstanceOf(RateLimitError);
  });

  it.each([[500], [503], [529]])("classifies a %i as retryable with its status", status => {
    const sdkError = apiError(status);

    const error = classifyAnthropicError(sdkError);

    expect(sdkError).toBeInstanceOf(InternalServerError);
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ status, kind: undefined });
  });

  it.each([[400], [401], [404], [413]])("classifies a %i as terminal with its status", status => {
    const error = classifyAnthropicError(apiError(status));

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({
      status,
      message: `[ai] Anthropic rejected the request (${status}).`
    });
  });

  it.each([
    ["a connection error", new APIConnectionError({ message: SECRET })],
    ["a stream error with no status", new APIError(undefined, undefined, SECRET, undefined)],
    ["a TypeError", new TypeError(SECRET)],
    ["a thrown string", SECRET]
  ])("classifies %s as retryable network", (_label, thrown) => {
    const error = classifyAnthropicError(thrown);

    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ kind: "network", status: undefined });
  });

  it("never copies the SDK message into the classified error", () => {
    const messages = [apiError(400), apiError(429), apiError(529), new TypeError(SECRET)].map(
      thrown => classifyAnthropicError(thrown).message
    );

    for (const message of messages) {
      expect(message).toMatch(/^\[ai\] Anthropic /);
      expect(message).not.toContain(SECRET);
    }
  });

  it("keeps the runner's hint fields as own properties of a retryable error", () => {
    const error = classifyAnthropicError(apiError(429, { "retry-after": "1" }));

    expect({ ...error }).toMatchObject({ status: 429, kind: undefined, retryAfterMs: 1000 });
    expect(Object.keys(error)).toEqual(expect.arrayContaining(["status", "kind", "retryAfterMs"]));
  });
});

describe("anthropic client: key and lazy client", () => {
  it("throws an unavailable auth error when the key is unset, so promptGen falls back", () => {
    const ctx = createFakeAnthropicContext();

    const error = (() => {
      try {
        getAnthropicClient(ctx);
      } catch (error_) {
        return error_;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(PromptGenUnavailableError);
    expect(isPromptGenUnavailable(error)).toBe(true);
    expect(error).toMatchObject({
      reason: "auth",
      message:
        "[ai] ANTHROPIC_API_KEY is not set.\n  Export it, or use another prompt-gen provider."
    });
    expect(ctx.state.client).toBeNull();
  });

  it("names config.apiKeyEnv in the missing-key message", () => {
    const ctx = createFakeAnthropicContext({ config: { apiKeyEnv: "STUDIO_CLAUDE_KEY" } });

    expect(() => getAnthropicClient(ctx)).toThrow(
      "[ai] STUDIO_CLAUDE_KEY is not set.\n  Export it, or use another prompt-gen provider."
    );
  });

  it("builds the client once the key is set and keeps it in state", () => {
    const ctx = createFakeAnthropicContext({ apiKey: "sk-ant-test" });

    const first = getAnthropicClient(ctx);

    expect(ctx.state.client).toBe(first);
    expect(getAnthropicClient(ctx)).toBe(first);
  });

  it("returns a client already in state without reading the key", () => {
    const { client } = createFakeAnthropicClient();
    const ctx = createFakeAnthropicContext({ state: { client } });

    expect(getAnthropicClient(ctx)).toBe(client);
  });
});

describe("anthropic client: request boundary", () => {
  it("passes the caller's signal to the stream and returns the final message", async () => {
    const { client, calls } = createFakeAnthropicClient([textAnswer("Fine.")]);
    const controller = new AbortController();

    const message = await requestMessage(client, BODY, controller.signal);

    expect(message.content).toEqual([{ type: "text", text: "Fine." }]);
    expect(calls[0]).toEqual({ params: BODY, signal: controller.signal });
  });

  it("sends no signal option when the caller has none", async () => {
    const seen: unknown[] = [];
    const { client } = createFakeAnthropicClient();
    const recording = {
      messages: {
        stream: (params: AnthropicRequestBody, options?: { signal?: AbortSignal }) => {
          seen.push(options);
          return client.messages.stream(params, options);
        }
      }
    };

    await requestMessage(recording, BODY, undefined);

    expect(seen).toEqual([{}]);
  });

  it("classifies an SDK failure of the stream", async () => {
    const { client } = createFakeAnthropicClient([apiError(529)]);

    await expect(requestMessage(client, BODY, undefined)).rejects.toMatchObject({ status: 529 });
  });

  it("rethrows the error unchanged once the caller aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const thrown = new TypeError("fetch aborted");
    const { client } = createFakeAnthropicClient([thrown]);

    await expect(requestMessage(client, BODY, controller.signal)).rejects.toBe(thrown);
  });
});

describe("anthropic client: redaction", () => {
  it.each([
    [
      new RetryableProviderError("[ai] x.", { status: 529 }),
      { errorType: "retryable", status: 529 }
    ],
    [
      new RetryableProviderError("[ai] x.", { kind: "timeout" }),
      { errorType: "retryable", kind: "timeout" }
    ],
    [new TerminalProviderError("[ai] x.", 400), { errorType: "terminal", status: 400 }],
    [new FlaggedProviderError("[ai] x."), { errorType: "flagged", kind: "content-policy" }],
    [new PromptGenUnavailableError("[ai] x.", "auth"), { errorType: "unavailable", kind: "auth" }],
    [new Error(SECRET), { errorType: "unknown" }]
  ])("reduces %o to its class and hint fields", (error, expected) => {
    const failure = redactedFailureOf(error);

    expect(failure).toMatchObject(expected);
    expect(JSON.stringify(failure)).not.toContain(SECRET);
  });
});
