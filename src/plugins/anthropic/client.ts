/**
 * @file anthropic SDK boundary — the lazy structural client over the
 * official SDK (`messages.stream(...).finalMessage()`, SDK retries off: the
 * runner owns retries), the missing-key error, the SDK error table mapped
 * onto this plugin's `RetryableProviderError` / `TerminalProviderError`
 * taxonomy with fixed messages, and the redacted log fields of a failure.
 */
import Anthropic, {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  RateLimitError
} from "@anthropic-ai/sdk";
import { PromptGenUnavailableError } from "../promptGen/contract";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "./errors";
import type {
  AnthropicCallOptions,
  AnthropicClient,
  AnthropicContentBlock,
  AnthropicContext,
  AnthropicMessage,
  AnthropicRequestBody
} from "./types";

/** The SDK's own retries are off: the runner owns retry timing, so a failure is never retried twice. */
const SDK_MAX_RETRIES = 0;

/**
 * fetch options that turn off Bun's socket idle timer
 * (`BUN_CONFIG_HTTP_IDLE_TIMEOUT`, about 5 min): a model that reasons for
 * minutes sends no byte, and only the configured timeout or the caller may
 * end the call. Node ignores the field.
 */
const BUN_NO_IDLE_TIMEOUT: { timeout: false } = { timeout: false };

/** Answer block kinds this plugin reads and sends back; the API sends no other kind without server tools. */
const CONTENT_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "text",
  "thinking",
  "redacted_thinking",
  "tool_use"
]);

/** Lowest HTTP status of a server error (5xx, 529 overloaded included): retried. */
const MIN_SERVER_ERROR = 500;

/** Milliseconds per second, for a Retry-After in seconds. */
const MS_PER_SECOND = 1000;

/** Status of a request this plugin refuses before any I/O. */
const BAD_REQUEST = 400;

/**
 * Redacted, loggable fields of a thrown error: its class and hint fields
 * only, never its message (spec/16 redaction rule).
 *
 * @example
 * ```ts
 * const failure: RedactedFailure = { errorType: "retryable", status: 529 };
 * ```
 */
export type RedactedFailure = {
  /** retryable, terminal, flagged, unavailable or unknown. */
  errorType: string;
  /** HTTP status, when the error has one. */
  status?: number | undefined;
  /** The hint kind or the unavailable reason, when the error has one. */
  kind?: string | undefined;
};

/**
 * Whether an SDK answer block is one this plugin reads and sends back.
 *
 * @param block - An answer block.
 * @param block.type - Its kind.
 * @returns True for text, thinking, redacted thinking and tool_use.
 * @example
 * ```ts
 * isContentBlock({ type: "server_tool_use" }); // => false
 * ```
 */
function isContentBlock(block: { type: string }): block is AnthropicContentBlock {
  return CONTENT_BLOCK_TYPES.has(block.type);
}

/**
 * The answer blocks of a final message that this plugin reads, in order.
 *
 * @param message - The SDK's final message.
 * @param message.content - Its answer blocks.
 * @returns The text, thinking, redacted thinking and tool_use blocks.
 * @example
 * ```ts
 * readableContent({ content: [{ type: "text", text: "hi" }, { type: "server_tool_use" }] }).length; // => 1
 * ```
 */
function readableContent(message: { content: Array<{ type: string }> }): AnthropicContentBlock[] {
  return message.content.flatMap((block): AnthropicContentBlock[] =>
    isContentBlock(block) ? [block] : []
  );
}

/**
 * Creates the structural client over the official SDK: one call,
 * `messages.stream(params, options).finalMessage()`. Streaming is required
 * for large `max_tokens`; the caller gets one final message. Its blocks are
 * the SDK's own objects, kept as they came, so a tool turn goes back
 * unchanged.
 *
 * @param options - API key, optional base URL, request timeout.
 * @param options.apiKey - The key read through ctx.env.
 * @param options.baseUrl - Optional API base URL override.
 * @param options.timeoutMs - Request timeout, ms.
 * @returns The structural client.
 * @example
 * ```ts
 * createAnthropicClient({ apiKey: "sk-ant-api03-…", timeoutMs: 900_000 }).messages.stream(body, { signal });
 * ```
 */
export function createAnthropicClient(options: {
  apiKey: string;
  baseUrl?: string;
  timeoutMs: number;
}): AnthropicClient {
  const raw = new Anthropic({
    apiKey: options.apiKey,
    timeout: options.timeoutMs,
    maxRetries: SDK_MAX_RETRIES,
    fetchOptions: BUN_NO_IDLE_TIMEOUT,
    ...(options.baseUrl === undefined ? {} : { baseURL: options.baseUrl })
  });
  return {
    messages: {
      stream: (params: AnthropicRequestBody, callOptions?: AnthropicCallOptions) => {
        const stream = raw.messages.stream(params, callOptions);
        return {
          finalMessage: async (): Promise<AnthropicMessage> => {
            const message = await stream.finalMessage();
            return {
              content: readableContent(message),
              stop_reason: message.stop_reason,
              usage: message.usage
            };
          }
        };
      }
    }
  };
}

/**
 * The error of an unset API key: unavailable with reason "auth", so
 * `promptGen` moves to the next provider of its fallback chain.
 *
 * @param envKey - `config.apiKeyEnv`.
 * @returns The error to throw.
 * @example
 * ```ts
 * missingApiKeyError("ANTHROPIC_API_KEY").message; // => "[ai] ANTHROPIC_API_KEY is not set.\n  Export it, or use another prompt-gen provider."
 * ```
 */
export function missingApiKeyError(envKey: string): PromptGenUnavailableError {
  return new PromptGenUnavailableError(
    `[ai] ${envKey} is not set.\n  Export it, or use another prompt-gen provider.`,
    "auth"
  );
}

/**
 * A terminal 400 for a request this plugin refuses before any I/O.
 *
 * @param message - The two-line `[ai] Anthropic …` message.
 * @returns The error to throw.
 * @example
 * ```ts
 * badRequest("[ai] Anthropic prompt-gen messages must not be empty.\n  Pass at least one user message.").status; // => 400
 * ```
 */
export function badRequest(message: string): TerminalProviderError {
  return new TerminalProviderError(message, BAD_REQUEST);
}

/**
 * The client of `ctx`: the one in state, else a new one built with the key
 * read through `ctx.env` now, and kept in state. `info()` and `estimate()`
 * never call this, so they never need the key.
 *
 * @param ctx - The anthropic plugin context.
 * @returns The client.
 * @throws {PromptGenUnavailableError} With reason "auth" when the key is unset.
 */
export function getAnthropicClient(ctx: AnthropicContext): AnthropicClient {
  if (ctx.state.client !== null) return ctx.state.client;

  const apiKey = ctx.env.get(ctx.config.apiKeyEnv);
  if (apiKey === undefined) throw missingApiKeyError(ctx.config.apiKeyEnv);

  const client = createAnthropicClient({
    apiKey,
    timeoutMs: ctx.config.timeoutMs,
    ...(ctx.config.baseUrl === undefined ? {} : { baseUrl: ctx.config.baseUrl })
  });
  ctx.state.client = client;
  return client;
}

/**
 * A Retry-After header in milliseconds: a delay in seconds, or an HTTP date
 * turned into the delay from now.
 *
 * @param headers - The response headers, when the error has them.
 * @returns The delay in ms, or undefined without a readable header.
 * @example
 * ```ts
 * retryAfterMsOf(new Headers({ "retry-after": "2" })); // => 2000
 * ```
 */
function retryAfterMsOf(headers: Headers | undefined): number | undefined {
  const raw = headers?.get("retry-after");
  if (raw === undefined || raw === null) return undefined;

  // A delay in seconds.
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds * MS_PER_SECOND;

  // An HTTP date: the delay from now.
  const dateMs = Date.parse(raw);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

/**
 * Maps a caught SDK error onto the provider error table: a caller abort is
 * returned unchanged; a timeout, a 429, a 5xx (529 included) and anything
 * without a status are retryable; any other status is terminal. Every
 * message is a fixed `[ai] Anthropic …` string, never the SDK's message.
 *
 * @param error - What the SDK call threw.
 * @returns The error to throw.
 * @example
 * ```ts
 * classifyAnthropicError(new APIConnectionTimeoutError()); // RetryableProviderError { kind: "timeout" }
 * ```
 */
export function classifyAnthropicError(error: unknown): Error {
  // A caller abort is the runner's clean pause, never a provider failure.
  if (error instanceof APIUserAbortError) return error;
  if (error instanceof APIConnectionTimeoutError) {
    return new RetryableProviderError("[ai] Anthropic request timed out.", { kind: "timeout" });
  }

  // Rate limit: retryable, with the provider's delay when it sent one.
  if (error instanceof RateLimitError) {
    const retryAfterMs = retryAfterMsOf(error.headers);
    return new RetryableProviderError(
      "[ai] Anthropic rate limited the request.",
      retryAfterMs === undefined ? { status: 429 } : { status: 429, retryAfterMs }
    );
  }

  // Any other HTTP status: a server error retries, a client error is final.
  const status = error instanceof APIError ? error.status : undefined;
  if (typeof status === "number" && status >= MIN_SERVER_ERROR) {
    return new RetryableProviderError(`[ai] Anthropic returned a server error (${status}).`, {
      status
    });
  }
  if (typeof status === "number") {
    return new TerminalProviderError(`[ai] Anthropic rejected the request (${status}).`, status);
  }

  // No status at all: the connection or the stream broke.
  return new RetryableProviderError("[ai] Anthropic request failed (network error).", {
    kind: "network"
  });
}

/**
 * The redacted log fields of a thrown error.
 *
 * @param error - The thrown error.
 * @returns Its class and hint fields, never its message.
 * @example
 * ```ts
 * redactedFailureOf(new TerminalProviderError("[ai] Anthropic rejected the request (400).", 400)); // => { errorType: "terminal", status: 400 }
 * ```
 */
export function redactedFailureOf(error: unknown): RedactedFailure {
  if (error instanceof RetryableProviderError) {
    return { errorType: "retryable", status: error.status, kind: error.kind };
  }
  if (error instanceof TerminalProviderError)
    return { errorType: "terminal", status: error.status };
  if (error instanceof FlaggedProviderError) return { errorType: "flagged", kind: error.kind };
  if (error instanceof PromptGenUnavailableError) {
    return { errorType: "unavailable", kind: error.reason };
  }
  return { errorType: "unknown" };
}

/**
 * Sends one streamed request and waits for its final message; an SDK
 * failure is classified, a failure after the caller aborted is rethrown
 * unchanged.
 *
 * @param client - The client.
 * @param body - The request body.
 * @param signal - Caller abort signal.
 * @returns The final message.
 * @throws {Error} The classified provider error, or the abort unchanged.
 */
export async function requestMessage(
  client: AnthropicClient,
  body: AnthropicRequestBody,
  signal: AbortSignal | undefined
): Promise<AnthropicMessage> {
  const options: AnthropicCallOptions = signal === undefined ? {} : { signal };
  try {
    return await client.messages.stream(body, options).finalMessage();
  } catch (error) {
    if (signal?.aborted === true) throw error;
    throw classifyAnthropicError(error);
  }
}
