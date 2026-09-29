/**
 * @file elevenlabs provider plugin — runtime provider error classes (values;
 * `types.ts` stays types-only and declares a type alias per class). This is
 * the runner-compatible provider error taxonomy that `client.ts` throws;
 * `runner/retry.ts`'s `classifyError` buckets each class by its structural
 * fields alone. Imports nothing from `./types`, so there is no module cycle.
 */

/**
 * Structural retry hint accepted by {@link RetryableProviderError}'s
 * constructor: a subset of the runner's own `ProviderErrorHint`
 * (`src/plugins/runner/types.ts`), deliberately NOT imported (no
 * cross-plugin type import; spec/10) — matched field-for-field so
 * `runner/retry.ts`'s `classifyError` buckets instances correctly by shape
 * alone.
 */
type RetryHint = {
  /** HTTP status code, when the failure came from an HTTP response (5xx or 429). */
  status?: number | undefined;
  /** Explicit classification hint for a non-HTTP retryable failure. */
  kind?: "timeout" | "network" | undefined;
  /** Provider-supplied Retry-After delay, ms. */
  retryAfterMs?: number | undefined;
};

/**
 * Retryable transport/provider failure: HTTP 5xx, HTTP 429 (with an
 * optional `Retry-After` hint), a request timeout, or a network-level
 * failure. Carries the structural fields `runner/retry.ts`'s
 * `classifyError` reads (`status`/`kind`/`retryAfterMs`) so instances are
 * bucketed as retryable without any cross-plugin error-class import.
 */
export class RetryableProviderError extends Error {
  readonly status: number | undefined;
  readonly kind: "timeout" | "network" | undefined;
  readonly retryAfterMs: number | undefined;

  /**
   * Creates a retryable provider error.
   *
   * @param message - Redacted human-readable message (never request text or response bodies).
   * @param hint - The structural classification hint (`status` for an HTTP code, `kind` for timeout/network, `retryAfterMs` for a provider-supplied delay).
   * @example
   * ```ts
   * throw new RetryableProviderError("[ai] ElevenLabs rate-limited the request.", {
   *   status: 429,
   *   retryAfterMs: 2_000
   * });
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
 * Deterministic 4xx failure (excluding 429) — never retried. Carries the
 * `status` field `runner/retry.ts`'s `classifyError` reads to bucket it as
 * `"http-4xx"` (terminal).
 */
export class TerminalProviderError extends Error {
  readonly status: number;

  /**
   * Creates a terminal provider error.
   *
   * @param message - Redacted human-readable message (never request text or response bodies).
   * @param status - The HTTP status code that caused the failure.
   * @example
   * ```ts
   * throw new TerminalProviderError("[ai] ElevenLabs rejected the request (HTTP 400).", 400);
   * ```
   */
  constructor(message: string, status: number) {
    super(message);
    this.name = "TerminalProviderError";
    this.status = status;
  }
}

/**
 * Content-policy rejection — terminal `flagged` state, never re-queued.
 * Carries `kind: "content-policy"`, the field `runner/retry.ts`'s
 * `classifyError` reads to bucket it as `"content-policy"`.
 */
export class FlaggedProviderError extends Error {
  readonly kind: "content-policy" = "content-policy";

  /**
   * Creates a content-policy provider error.
   *
   * @param message - Redacted human-readable message (never request text or response bodies).
   * @example
   * ```ts
   * throw new FlaggedProviderError("[ai] ElevenLabs rejected the request for content-policy reasons.");
   * ```
   */
  constructor(message: string) {
    super(message);
    this.name = "FlaggedProviderError";
  }
}
