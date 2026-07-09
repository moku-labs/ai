/**
 * @file elevenlabs thin fetch client (global fetch — Node ≥24 and Bun).
 * Generic POST + response handling for any ElevenLabs endpoint; owns the
 * one place that reads a raw `Response` and classifies HTTP/timeout/network
 * failures into the plugin's `RetryableProviderError`/`TerminalProviderError`/
 * `FlaggedProviderError` taxonomy (spec/10). Per-task submodules (e.g.
 * `voiceover/handler.ts`) build the endpoint path + request body; this file
 * never inspects task-specific request/response shapes.
 */
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "./types";

/** Options for one ElevenLabs API request. */
export type ElevenlabsRequestOptions = {
  /** API base URL, e.g. "https://api.elevenlabs.io". */
  baseUrl: string;
  /** Request path (including any query string), e.g. "/v1/text-to-speech/voice1". */
  path: string;
  /** API key, resolved via ctx.env at request time — never logged or stored. */
  apiKey: string;
  /** JSON request body. */
  body: Record<string, unknown>;
  /** Request timeout, ms. */
  timeoutMs: number;
  /** Caller-supplied abort signal; aborting it cancels the in-flight fetch (clean-pause propagation). */
  signal?: AbortSignal;
};

/** The `detail` fields ElevenLabs' validation-error envelope carries, as far as this client reads it. */
type ElevenlabsErrorDetail = { status?: string | undefined; message?: string | undefined };

/**
 * Reads a `Retry-After` header value (seconds, or an HTTP-date) into a
 * millisecond delay.
 *
 * @param value - The raw `Retry-After` header value, or null when absent.
 * @returns The delay in ms, or undefined when `value` is absent or unparseable.
 * @example
 * ```ts
 * retryAfterMsFromHeader("2"); // => 2000
 * ```
 */
function retryAfterMsFromHeader(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

/**
 * Narrows a parsed JSON error body down to its `detail.status`/`detail.message`
 * fields, when present — the genuine dynamic boundary this client reads (an
 * untrusted response body), validated field-by-field before use (spec/09 R9).
 *
 * @param parsedBody - The response body, already `JSON.parse`d (or undefined when parsing failed).
 * @returns The `detail` fields ElevenLabs' error envelope carries, or an empty object.
 * @example
 * ```ts
 * extractErrorDetail({ detail: { status: "invalid_content" } }); // => { status: "invalid_content" }
 * ```
 */
function extractErrorDetail(parsedBody: unknown): ElevenlabsErrorDetail {
  if (typeof parsedBody !== "object" || parsedBody === null || !("detail" in parsedBody)) return {};
  const { detail } = parsedBody;
  if (typeof detail !== "object" || detail === null) return {};
  const status =
    "status" in detail && typeof detail.status === "string" ? detail.status : undefined;
  const message =
    "message" in detail && typeof detail.message === "string" ? detail.message : undefined;
  return { status, message };
}

/**
 * Parses a failed response's JSON body, tolerating a non-JSON or empty body.
 *
 * @param response - The failed HTTP response.
 * @returns The parsed body, or undefined when it isn't valid JSON.
 * @example
 * ```ts
 * const body = await parseErrorBody(response);
 * ```
 */
async function parseErrorBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Classifies a failed HTTP response into the plugin's provider error
 * taxonomy: a `detail.status` of `"content_policy_violation"` is flagged
 * regardless of numeric status; else 429 and 5xx are retryable; every other
 * 4xx is terminal. Never includes the response body in the thrown message —
 * only the status code (redaction rule, spec/10).
 *
 * @param response - The failed HTTP response.
 * @returns The classified provider error to throw.
 * @example
 * ```ts
 * throw await classifyHttpFailure(response);
 * ```
 */
async function classifyHttpFailure(response: Response): Promise<Error> {
  const detail = extractErrorDetail(await parseErrorBody(response));
  if (detail.status === "content_policy_violation") {
    return new FlaggedProviderError(
      "[ai] ElevenLabs rejected the request for content-policy reasons."
    );
  }
  if (response.status === 429) {
    const retryAfterMs = retryAfterMsFromHeader(response.headers.get("retry-after"));
    return new RetryableProviderError("[ai] ElevenLabs rate-limited the request.", {
      status: 429,
      retryAfterMs
    });
  }
  if (response.status >= 500) {
    return new RetryableProviderError(`[ai] ElevenLabs returned HTTP ${response.status}.`, {
      status: response.status
    });
  }
  return new TerminalProviderError(
    `[ai] ElevenLabs rejected the request (HTTP ${response.status}).`,
    response.status
  );
}

/**
 * Merges the caller's abort signal (if any) with an internal timeout
 * signal, so `elevenlabsRequest` enforces `timeoutMs` regardless of whether
 * a caller signal was supplied.
 *
 * @param external - The caller-supplied abort signal, if any.
 * @param timeout - The internal timeout signal.
 * @returns The merged signal fetch should observe.
 * @example
 * ```ts
 * const signal = mergeSignals(options.signal, AbortSignal.timeout(60_000));
 * ```
 */
function mergeSignals(external: AbortSignal | undefined, timeout: AbortSignal): AbortSignal {
  return external === undefined ? timeout : AbortSignal.any([external, timeout]);
}

/**
 * Performs one ElevenLabs API request and returns the binary response body,
 * throwing the provider error taxonomy on failure. Enforces `timeoutMs` via
 * an internal `AbortSignal.timeout`, merged with the caller's own `signal`
 * (clean-pause propagation — a caller abort cancels the in-flight fetch and
 * propagates unchanged, rather than being reclassified as a timeout).
 *
 * @param options - Request options (URL, key, body, timeout, signal).
 * @returns The response body as raw bytes.
 * @throws {RetryableProviderError} On HTTP 5xx/429, a timeout, or a network failure.
 * @throws {TerminalProviderError} On any other HTTP 4xx.
 * @throws {FlaggedProviderError} On a content-policy rejection.
 * @example
 * ```ts
 * const audio = await elevenlabsRequest(options);
 * ```
 */
export async function elevenlabsRequest(options: ElevenlabsRequestOptions): Promise<Uint8Array> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const signal = mergeSignals(options.signal, timeoutSignal);

  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}${options.path}`, {
      method: "POST",
      headers: { "xi-api-key": options.apiKey, "content-type": "application/json" },
      body: JSON.stringify(options.body),
      signal
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (timeoutSignal.aborted) {
      throw new RetryableProviderError("[ai] ElevenLabs request timed out.", { kind: "timeout" });
    }
    throw new RetryableProviderError("[ai] ElevenLabs request failed.", { kind: "network" });
  }

  if (!response.ok) throw await classifyHttpFailure(response);

  return new Uint8Array(await response.arrayBuffer());
}
