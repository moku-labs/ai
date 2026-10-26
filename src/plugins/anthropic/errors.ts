/**
 * @file anthropic provider plugin — runtime provider error classes (values;
 * `types.ts` stays types-only). The runner-compatible taxonomy:
 * `RetryableProviderError` (5xx, 529, 429, timeout, network),
 * `TerminalProviderError` (other 4xx and refused requests) and
 * `FlaggedProviderError` (a refusal).
 */

/**
 * Anthropic's error type and message of a 4xx answer (`error.type`,
 * `error.message`). The message names the field at fault (for example
 * `tools.15.custom.input_schema: …`); it carries no prompt text.
 *
 * @example
 * ```ts
 * const api: ApiErrorDetail = { type: "invalid_request_error", message: "max_tokens: too large" };
 * ```
 */
export type ApiErrorDetail = {
  /** The error type, e.g. `invalid_request_error`. */
  type: string;
  /** The error message, cut to 300 characters. */
  message: string;
};

/**
 * Retryable transport or provider failure: 5xx (529 overloaded included),
 * 429, timeout or network. Carries exactly the fields the runner's
 * `classifyError` reads, as own instance properties: `status`, `kind` and
 * `retryAfterMs`.
 */
export class RetryableProviderError extends Error {
  /** HTTP status, when the failure came from an HTTP response. */
  readonly status: number | undefined;
  /** `timeout` or `network`, when there is no status. */
  readonly kind: "timeout" | "network" | undefined;
  /** The provider's Retry-After delay, ms. */
  readonly retryAfterMs: number | undefined;

  /**
   * Creates a retryable provider error.
   *
   * @param message - Fixed `[ai] Anthropic …` message; never request or answer text.
   * @param hint - The runner's hint fields for this failure.
   * @param hint.status - HTTP status, when the failure came from an HTTP response.
   * @param hint.kind - `timeout` or `network`, when there is no status.
   * @param hint.retryAfterMs - The provider's Retry-After delay, ms.
   * @example
   * ```ts
   * throw new RetryableProviderError("[ai] Anthropic rate limited the request.", { status: 429, retryAfterMs: 2_000 });
   * ```
   */
  constructor(
    message: string,
    hint: { status?: number; kind?: "timeout" | "network"; retryAfterMs?: number } = {}
  ) {
    super(message);
    this.name = "RetryableProviderError";
    this.status = hint.status;
    this.kind = hint.kind;
    this.retryAfterMs = hint.retryAfterMs;
  }
}

/** Deterministic failure (a 4xx other than 429, or a request refused before I/O): never retried. */
export class TerminalProviderError extends Error {
  /** HTTP status, when known. */
  readonly status: number | undefined;
  /** Anthropic's error type and message of a 4xx answer, when it sent them. */
  readonly api: ApiErrorDetail | undefined;

  /**
   * Creates a terminal provider error.
   *
   * @param message - `[ai] Anthropic …` message; never request or answer text.
   * @param status - HTTP status, when known.
   * @param api - Anthropic's error type and message, when it sent them.
   * @example
   * ```ts
   * throw new TerminalProviderError("[ai] Anthropic rejected the request (400).", 400);
   * ```
   */
  constructor(message: string, status?: number, api?: ApiErrorDetail) {
    super(message);
    this.name = "TerminalProviderError";
    this.status = status;
    this.api = api;
  }
}

/** The model refused to answer (`stop_reason: "refusal"`): terminal `flagged`, never re-queued. */
export class FlaggedProviderError extends Error {
  /** Always `content-policy`: the runner flags the item instead of retrying. */
  readonly kind = "content-policy" as const;

  /**
   * Creates a refusal error.
   *
   * @param message - Fixed `[ai] Anthropic …` message; never request or answer text.
   * @example
   * ```ts
   * throw new FlaggedProviderError("[ai] Anthropic declined the request (refusal).");
   * ```
   */
  constructor(message: string) {
    super(message);
    this.name = "FlaggedProviderError";
  }
}
