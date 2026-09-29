/**
 * @file ark provider plugin — the runner-compatible provider error taxonomy.
 * Runtime provider error classes — values; `types.ts` stays types-only.
 */

/**
 * Structural retry hint accepted by {@link RetryableProviderError}'s
 * constructor: a subset of the runner's own `ProviderErrorHint`, matched
 * field-for-field (no cross-plugin type import) so `runner/retry.ts`'s
 * `classifyError` buckets instances by shape alone.
 *
 * @example
 * ```ts
 * const hint: RetryHint = { status: 429, retryAfterMs: 2000 };
 * ```
 */
export type RetryHint = {
  /** HTTP status code, when the failure came from an HTTP response (5xx or 429). */
  status?: number | undefined;
  /** Explicit classification hint for a non-HTTP retryable failure. */
  kind?: "timeout" | "network" | undefined;
  /** Provider-supplied Retry-After delay, ms. */
  retryAfterMs?: number | undefined;
};

/**
 * Retryable transport/provider failure: HTTP 5xx, HTTP 429 or an OpenAPI
 * throttling error (with an optional `Retry-After` hint), a request
 * timeout, a network failure, or a response ark sent but that could not be
 * read. Carries the structural fields the runner's `classifyError` reads
 * (`status`/`kind`/`retryAfterMs`).
 *
 * @example
 * ```ts
 * throw new RetryableProviderError("[ai] ark returned HTTP 503.", { status: 503 });
 * ```
 */
export class RetryableProviderError extends Error {
  /** HTTP status code, when the failure came from an HTTP response (5xx or 429). */
  readonly status: number | undefined;
  /** Explicit classification hint for a non-HTTP retryable failure. */
  readonly kind: "timeout" | "network" | undefined;
  /** Provider-supplied Retry-After delay, ms. */
  readonly retryAfterMs: number | undefined;

  /**
   * Creates a retryable provider error.
   *
   * @param message - Human-readable message (never a key, a URL or the prompt).
   * @param hint - The structural classification hint.
   * @example
   * ```ts
   * new RetryableProviderError("[ai] ark rate-limited /contents/generations/tasks (429).", { status: 429, retryAfterMs: 2000 });
   * ```
   */
  constructor(message: string, hint: RetryHint) {
    super(message);
    this.name = "RetryableProviderError";
    this.status = hint.status;
    this.kind = hint.kind;
    this.retryAfterMs = hint.retryAfterMs;
  }
}

/**
 * Deterministic failure (a 4xx other than 429, an OpenAPI error, a failed,
 * expired or cancelled task, an asset that fails the preflight) — never
 * retried. Carries the `status` field the runner's `classifyError` reads to
 * bucket it as `"http-4xx"`, and ark's own error code when it gave one.
 *
 * @example
 * ```ts
 * throw new TerminalProviderError("[ai] ark task cgt-1 is expired.", 410);
 * ```
 */
export class TerminalProviderError extends Error {
  /** The HTTP status code that caused the failure. */
  readonly status: number;
  /** ark's error code (`error.code` or `ResponseMetadata.Error.Code`), when it gave one. */
  readonly code: string | undefined;

  /**
   * Creates a terminal provider error.
   *
   * @param message - Human-readable message (never a key, a URL or the prompt).
   * @param status - The HTTP status code that caused the failure.
   * @param code - ark's error code, when it gave one.
   * @example
   * ```ts
   * new TerminalProviderError("[ai] ark /contents/generations/tasks failed (400 InvalidParameter): bad ratio.", 400, "InvalidParameter");
   * ```
   */
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "TerminalProviderError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Content-policy rejection — terminal `flagged` state, never re-queued.
 * Carries `kind: "content-policy"`, the field the runner's `classifyError`
 * reads to bucket it as `"content-policy"`.
 *
 * @example
 * ```ts
 * throw new FlaggedProviderError("[ai] ark flagged the request: InputTextSensitiveContentDetected.\n  Change the prompt or the inputs.");
 * ```
 */
export class FlaggedProviderError extends Error {
  /** Classification the runner reads to bucket the failure as `"content-policy"`. */
  readonly kind: "content-policy" = "content-policy";

  /**
   * Creates a content-policy provider error.
   *
   * @param message - Human-readable message (never a key, a URL or the prompt).
   * @example
   * ```ts
   * new FlaggedProviderError("[ai] ark refused asset \"mira.png\": face not detected.\n  Items that use it will not run.");
   * ```
   */
  constructor(message: string) {
    super(message);
    this.name = "FlaggedProviderError";
  }
}
