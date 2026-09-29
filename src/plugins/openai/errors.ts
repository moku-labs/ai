/**
 * @file openai provider plugin — runtime provider error classes — values;
 * `types.ts` stays types-only. The runner-compatible error taxonomy:
 * `RetryableProviderError` (5xx/429/timeout/network), `TerminalProviderError`
 * (other 4xx) and `FlaggedProviderError` (content policy / refusal).
 */

/**
 * Retryable transport/provider failure: 5xx, 429, timeout, or network.
 * Carries exactly the structural fields the runner's `classifyError`
 * (`src/plugins/runner/types.ts` `ProviderErrorHint`) reads: `status`,
 * `kind`, and `retryAfterMs`.
 */
export class RetryableProviderError extends Error {
  readonly status: number | undefined;
  readonly kind: "timeout" | "network" | undefined;
  readonly retryAfterMs: number | undefined;

  /**
   * Creates a retryable provider error.
   *
   * @param message - Redacted human-readable message (never request/response text).
   * @param hint - The runner's `ProviderErrorHint` fields for this failure.
   * @param hint.status - HTTP status code, when the failure came from an HTTP response.
   * @param hint.kind - Explicit classification hint overriding status-based inference.
   * @param hint.retryAfterMs - Provider-supplied Retry-After delay, ms.
   * @example
   * ```ts
   * throw new RetryableProviderError("[ai] OpenAI rate limited the request.", {
   *   status: 429,
   *   retryAfterMs: 1_000
   * });
   * ```
   */
  constructor(
    message: string,
    hint: { status?: number; kind?: "timeout" | "network"; retryAfterMs?: number } = {}
  ) {
    super(message);
    this.status = hint.status;
    this.kind = hint.kind;
    this.retryAfterMs = hint.retryAfterMs;
  }
}

/** Deterministic 4xx failure (excluding 429) — never retried. */
export class TerminalProviderError extends Error {
  readonly status: number | undefined;

  /**
   * Creates a terminal provider error.
   *
   * @param message - Redacted human-readable message (never request/response text).
   * @param status - HTTP status code, when the failure came from an HTTP response.
   * @example
   * ```ts
   * throw new TerminalProviderError("[ai] OpenAI rejected the request (400).", 400);
   * ```
   */
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** Content-policy rejection/refusal — terminal `flagged` state, never re-queued. */
export class FlaggedProviderError extends Error {
  readonly kind = "content-policy" as const;
}
