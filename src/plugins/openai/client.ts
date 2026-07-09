/**
 * @file openai lazy SDK client factory + SDK request/error boundary. Owns
 * client construction/caching, the missing-key error, per-request signal
 * passthrough, and mapping caught SDK errors onto this plugin's
 * `RetryableProviderError` / `TerminalProviderError` / `FlaggedProviderError`
 * taxonomy (`src/plugins/runner/retry.ts` `classifyError` reads the hint
 * fields those classes carry).
 */
import OpenAI, {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  RateLimitError
} from "openai";
import type {
  OpenaiCallOptions,
  OpenaiChatCompletion,
  OpenaiChatRequestBody,
  OpenaiClient,
  OpenaiContext,
  OpenaiSpeechRequestBody,
  OpenaiSpeechResult
} from "./types";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "./types";

/**
 * The SDK retries 5xx/429/timeout requests internally by default. This
 * plugin surfaces those failures to the runner instead, which owns retry
 * timing/backoff/jitter (`src/plugins/runner/retry.ts`) — so the SDK's own
 * retry loop is disabled to avoid double-retrying the same failure.
 */
const SDK_MAX_RETRIES = 0;

/**
 * Creates the OpenAI SDK client lazily (constructed on first use, not at
 * init). A thin, structurally-typed wrapper around the real SDK client: each
 * method forwards to the real SDK call with our own request/response types,
 * so overload resolution on the real client picks the correct (non-streaming)
 * signature and the return value structurally satisfies {@link OpenaiClient}.
 *
 * @param options - API key, optional base URL, and request timeout.
 * @param options.apiKey - API key read via ctx.env.
 * @param options.baseUrl - Optional API base URL override.
 * @param options.timeoutMs - Request timeout, ms.
 * @returns The structurally-typed OpenAI client.
 * @example
 * ```ts
 * const client = createOpenaiClient({ apiKey, timeoutMs: 60_000 });
 * ```
 */
export function createOpenaiClient(options: {
  apiKey: string;
  baseUrl?: string;
  timeoutMs: number;
}): OpenaiClient {
  const raw = new OpenAI({
    apiKey: options.apiKey,
    timeout: options.timeoutMs,
    maxRetries: SDK_MAX_RETRIES,
    ...(options.baseUrl === undefined ? {} : { baseURL: options.baseUrl })
  });
  return {
    audio: {
      speech: {
        /**
         * Synthesizes speech via the real SDK client, forwarding our own
         * request/options types so overload resolution on the real client
         * picks the non-streaming signature.
         *
         * @param params - The tts request body.
         * @param callOptions - Per-request options (abort signal).
         * @returns The synthesized audio response.
         * @example
         * ```ts
         * client.audio.speech.create({ model, voice, input }, { signal });
         * ```
         */
        create: (
          params: OpenaiSpeechRequestBody,
          callOptions?: OpenaiCallOptions
        ): Promise<OpenaiSpeechResult> => raw.audio.speech.create(params, callOptions)
      }
    },
    chat: {
      completions: {
        /**
         * Generates a chat completion via the real SDK client, forwarding
         * our own request/options types so overload resolution on the real
         * client picks the non-streaming signature.
         *
         * @param params - The chat completion request body.
         * @param callOptions - Per-request options (abort signal).
         * @returns The generated completion.
         * @example
         * ```ts
         * client.chat.completions.create({ model, messages }, { signal });
         * ```
         */
        create: (
          params: OpenaiChatRequestBody,
          callOptions?: OpenaiCallOptions
        ): Promise<OpenaiChatCompletion> => raw.chat.completions.create(params, callOptions)
      }
    }
  };
}

/**
 * Builds the pinned two-line "API key not set" error.
 *
 * @param envKey - The configured env var name that holds the API key.
 * @returns A two-line `Error` in the exact `[ai] <VAR> is not set.` format.
 * @example
 * ```ts
 * throw missingApiKeyError("OPENAI_API_KEY");
 * ```
 */
export function missingApiKeyError(envKey: string): Error {
  return new Error(
    `[ai] ${envKey} is not set.\n  Export it or set config.apiKeyEnv to the variable that holds your key.`
  );
}

/**
 * Resolves the SDK client for `ctx`: returns the cached client when already
 * constructed, otherwise reads the API key via `ctx.env` (throwing the
 * pinned missing-key error when absent) and lazily constructs + caches one.
 * No key is required until this is called — `info()`/`estimate()` never call it.
 *
 * @param ctx - The openai plugin context.
 * @returns The resolved SDK client.
 * @throws {Error} When `config.apiKeyEnv` is unset in the environment.
 * @example
 * ```ts
 * const client = getOpenaiClient(ctx);
 * ```
 */
export function getOpenaiClient(ctx: OpenaiContext): OpenaiClient {
  if (ctx.state.client !== null) return ctx.state.client;
  const apiKey = ctx.env.get(ctx.config.apiKeyEnv);
  if (apiKey === undefined) throw missingApiKeyError(ctx.config.apiKeyEnv);
  const client = createOpenaiClient({
    apiKey,
    timeoutMs: ctx.config.timeoutMs,
    ...(ctx.config.baseUrl === undefined ? {} : { baseUrl: ctx.config.baseUrl })
  });
  ctx.state.client = client;
  return client;
}

/**
 * Builds the per-request call options forwarded to the SDK, omitting
 * `signal` entirely rather than setting it to `undefined` (required under
 * `exactOptionalPropertyTypes`).
 *
 * @param signal - The caller-supplied abort signal, if any.
 * @returns The options object to forward to an {@link OpenaiClient} call.
 * @example
 * ```ts
 * client.chat.completions.create(params, toOpenaiCallOptions(opts.signal));
 * ```
 */
export function toOpenaiCallOptions(signal: AbortSignal | undefined): OpenaiCallOptions {
  return signal === undefined ? {} : { signal };
}

/**
 * Whether a caught SDK error represents a content-policy rejection/refusal
 * — detected from the OpenAI error body's `code`/`type` fields (e.g.
 * `content_policy_violation`).
 *
 * @param error - The caught error.
 * @returns True when `error` is an `APIError` carrying a content-policy marker.
 * @example
 * ```ts
 * if (isContentPolicyError(error)) throw new FlaggedProviderError("...");
 * ```
 */
function isContentPolicyError(error: unknown): boolean {
  if (!(error instanceof APIError)) return false;
  const marker = `${error.code ?? ""} ${error.type ?? ""}`.toLowerCase();
  return (
    marker.includes("content_policy") ||
    marker.includes("content_filter") ||
    marker.includes("moderation")
  );
}

/**
 * Reads a provider `Retry-After` header off a rate-limit error's headers
 * and converts it to milliseconds. Handles both header forms: a delay in
 * seconds, or an HTTP-date (converted to a delay from now) — proxies and
 * OpenAI-compatible endpoints (`config.baseUrl`) may emit either.
 *
 * @param headers - The response headers from a `RateLimitError`.
 * @returns The delay in ms, or undefined when no valid header is present.
 * @example
 * ```ts
 * const retryAfterMs = retryAfterMsFromHeaders(error.headers);
 * ```
 */
function retryAfterMsFromHeaders(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;

  // Numeric form: a delay in seconds.
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds * 1000;

  // HTTP-date form: an absolute time — convert to a delay from now.
  const dateMs = Date.parse(raw);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

/**
 * Classifies a caught OpenAI SDK error into this plugin's provider error
 * taxonomy — `RetryableProviderError` (5xx/429/timeout/network),
 * `TerminalProviderError` (other 4xx), or `FlaggedProviderError`
 * (content-policy) — with the runner's `ProviderErrorHint` fields set so
 * `src/plugins/runner/retry.ts` `classifyError` lands each throw in the
 * right taxonomy row. Never echoes the caught error's own message (which
 * may embed request/response text) — every returned message is a fixed,
 * redacted string.
 *
 * @param error - The error caught from an {@link OpenaiClient} call.
 * @returns The classified provider error to throw.
 * @example
 * ```ts
 * try {
 *   return await client.chat.completions.create(params, options);
 * } catch (error) {
 *   throw classifyOpenaiError(error);
 * }
 * ```
 */
export function classifyOpenaiError(error: unknown): Error {
  // A caller-initiated abort is the runner's deliberate clean pause, not a
  // provider failure — return it unchanged so it is never classified as
  // retryable (which would penalize the circuit breaker and burn an attempt).
  if (error instanceof APIUserAbortError) return error;
  if (error instanceof APIConnectionTimeoutError) {
    return new RetryableProviderError("[ai] OpenAI request timed out.", { kind: "timeout" });
  }
  if (isContentPolicyError(error)) {
    return new FlaggedProviderError("[ai] OpenAI declined the request (content policy).");
  }
  if (error instanceof RateLimitError) {
    const retryAfterMs = retryAfterMsFromHeaders(error.headers);
    return new RetryableProviderError(
      "[ai] OpenAI rate limited the request.",
      retryAfterMs === undefined ? { status: 429 } : { status: 429, retryAfterMs }
    );
  }
  if (error instanceof APIError && typeof error.status === "number" && error.status >= 500) {
    return new RetryableProviderError(`[ai] OpenAI returned a server error (${error.status}).`, {
      status: error.status
    });
  }
  if (error instanceof APIError && typeof error.status === "number") {
    return new TerminalProviderError(
      `[ai] OpenAI rejected the request (${error.status}).`,
      error.status
    );
  }
  return new RetryableProviderError("[ai] OpenAI request failed (network error).", {
    kind: "network"
  });
}

/**
 * Redacted, loggable fields of a thrown provider error: error class plus
 * status/kind only — never the original error message (which may embed
 * request/response text). The redaction rule (spec/11).
 */
export type RedactedFailure = {
  errorType: string;
  status?: number | undefined;
  kind?: string | undefined;
};

/**
 * Extracts redacted fields from a thrown error for `ctx.log` — shared by
 * all three handler submodules through the plugin root.
 *
 * @param error - The thrown error.
 * @returns The redacted fields to pass to `ctx.log`.
 * @example
 * ```ts
 * ctx.log.warn("openai:tts:failed", redactedFailureOf(error));
 * ```
 */
export function redactedFailureOf(error: unknown): RedactedFailure {
  if (error instanceof RetryableProviderError) {
    return { errorType: "retryable", status: error.status, kind: error.kind };
  }
  if (error instanceof TerminalProviderError) {
    return { errorType: "terminal", status: error.status };
  }
  if (error instanceof FlaggedProviderError) {
    return { errorType: "flagged", kind: error.kind };
  }
  return { errorType: "unknown" };
}

/**
 * Resolves the SDK client and requests a chat completion, mapping any
 * thrown SDK error onto this plugin's provider error taxonomy. In-band
 * outcomes (missing choices, model refusal) are the caller's concern — this
 * only handles the SDK request/transport boundary.
 *
 * @param ctx - The openai plugin context.
 * @param params - The chat completion request body.
 * @param signal - The caller-supplied abort signal, if any.
 * @returns The chat completion response.
 * @throws {Error} When the API key is unset, or the request fails.
 * @example
 * ```ts
 * const completion = await requestChatCompletion(ctx, params, opts.signal);
 * ```
 */
export async function requestChatCompletion(
  ctx: OpenaiContext,
  params: OpenaiChatRequestBody,
  signal: AbortSignal | undefined
): Promise<OpenaiChatCompletion> {
  const client = getOpenaiClient(ctx);
  try {
    return await client.chat.completions.create(params, toOpenaiCallOptions(signal));
  } catch (error) {
    // Caller-initiated abort propagates unchanged (clean-pause contract).
    if (signal?.aborted) throw error;
    throw classifyOpenaiError(error);
  }
}

/**
 * Resolves the SDK client and requests speech synthesis, mapping any
 * thrown SDK error onto this plugin's provider error taxonomy.
 *
 * @param ctx - The openai plugin context.
 * @param params - The tts request body.
 * @param signal - The caller-supplied abort signal, if any.
 * @returns The synthesized speech response.
 * @throws {Error} When the API key is unset, or the request fails.
 * @example
 * ```ts
 * const response = await requestSpeech(ctx, params, opts.signal);
 * ```
 */
export async function requestSpeech(
  ctx: OpenaiContext,
  params: OpenaiSpeechRequestBody,
  signal: AbortSignal | undefined
): Promise<OpenaiSpeechResult> {
  const client = getOpenaiClient(ctx);
  try {
    return await client.audio.speech.create(params, toOpenaiCallOptions(signal));
  } catch (error) {
    // Caller-initiated abort propagates unchanged (clean-pause contract).
    if (signal?.aborted) throw error;
    throw classifyOpenaiError(error);
  }
}
