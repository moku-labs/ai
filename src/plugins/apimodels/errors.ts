/**
 * @file apimodels provider plugin — runtime provider error classes — values;
 * `types.ts` stays types-only. The runner-compatible error taxonomy:
 * `RetryableProviderError` (5xx/429/timeout/network/resubmit),
 * `TerminalProviderError` (other 4xx, non-retryable task failures) and
 * `FlaggedProviderError` (content policy), plus the `RetryHint` and
 * `UpstreamFailure` shapes their constructors take.
 */

/**
 * Structural retry hint accepted by {@link RetryableProviderError}'s
 * constructor: the fields the runner's `classifyError` reads, matched
 * field-for-field (no cross-plugin type import).
 *
 * @example
 * ```ts
 * const hint: RetryHint = { status: 503, kind: "resubmit" };
 * ```
 */
export type RetryHint = {
  /** HTTP status code, when the failure came from an HTTP response (5xx or 429). */
  status?: number | undefined;
  /**
   * `"timeout"` / `"network"` for a transport failure. `"resubmit"` when the job
   * must be submitted again (a stale asset id, a task apimodels lost, a dead
   * result URL): the runner retries it like its status says, without counting
   * it against the lane breaker.
   */
  kind?: "timeout" | "network" | "resubmit" | undefined;
  /** Provider-supplied Retry-After delay, ms. */
  retryAfterMs?: number | undefined;
};

/**
 * Retryable transport or provider failure: HTTP 5xx, HTTP 429 (with an
 * optional `Retry-After` hint), a request timeout, a network failure, a
 * task apimodels failed with a retryable code, or a job that must be
 * submitted again (`kind: "resubmit"`). Carries the structural fields the
 * runner's `classifyError` reads (`status`/`kind`/`retryAfterMs`).
 *
 * @example
 * ```ts
 * throw new RetryableProviderError("[ai] apimodels returned HTTP 503.\n  The runner retries it.", { status: 503 });
 * ```
 */
export class RetryableProviderError extends Error {
  /** HTTP status code, when the failure came from an HTTP response (5xx or 429). */
  readonly status: number | undefined;
  /** `"timeout"` / `"network"` for a transport failure; `"resubmit"` for a job to submit again. */
  readonly kind: "timeout" | "network" | "resubmit" | undefined;
  /** Provider-supplied Retry-After delay, ms. */
  readonly retryAfterMs: number | undefined;

  /**
   * Creates a retryable provider error.
   *
   * @param message - Human-readable message (never the key or the prompt).
   * @param hint - The structural classification hint.
   * @example
   * ```ts
   * new RetryableProviderError("[ai] apimodels rate-limited the request (HTTP 429).\n  The runner retries after Retry-After.", { status: 429, retryAfterMs: 2000 });
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
 * What apimodels said about a rejected call, kept on a
 * {@link TerminalProviderError}: its `failCode` and its (redacted, shortened)
 * text. Lets `submit` tell a stale `asset://` id from another bad request.
 *
 * @example
 * ```ts
 * const upstream: UpstreamFailure = { failCode: "INVALID_INPUT", detail: "asset not found" };
 * ```
 */
export type UpstreamFailure = {
  /** apimodels `failCode`, when it named one. */
  failCode?: string | undefined;
  /** apimodels' own text, redacted and shortened. */
  detail?: string | undefined;
};

/**
 * Deterministic failure (a 4xx other than 429, or a task apimodels failed
 * with a non-retryable code): never retried. Carries the `status` field the
 * runner's `classifyError` reads to bucket it as `"http-4xx"`.
 *
 * @example
 * ```ts
 * throw new TerminalProviderError("[ai] apimodels rejected the request (HTTP 400).\n  Check the request fields.", 400);
 * ```
 */
export class TerminalProviderError extends Error {
  /** The HTTP status code that caused the failure. */
  readonly status: number;
  /** apimodels `failCode`, when it named one. */
  readonly failCode: string | undefined;
  /** apimodels' own text, redacted and shortened. */
  readonly detail: string | undefined;

  /**
   * Creates a terminal provider error.
   *
   * @param message - Human-readable message (never the key or the prompt).
   * @param status - The HTTP status code that caused the failure.
   * @param upstream - What apimodels said, when it said anything.
   * @example
   * ```ts
   * new TerminalProviderError("[ai] apimodels rejected the request (HTTP 400).\n  Check the request fields.", 400, { failCode: "INVALID_INPUT" });
   * ```
   */
  constructor(message: string, status: number, upstream: UpstreamFailure = {}) {
    super(message);
    this.name = "TerminalProviderError";
    this.status = status;
    this.failCode = upstream.failCode;
    this.detail = upstream.detail;
  }
}

/**
 * Content-policy rejection: terminal `flagged` state, never re-queued.
 * Carries `kind: "content-policy"`, the field the runner's `classifyError`
 * reads to bucket it as `"content-policy"`.
 *
 * @example
 * ```ts
 * throw new FlaggedProviderError("[ai] apimodels flagged the asset (HTTP 422).\n  Use another image.");
 * ```
 */
export class FlaggedProviderError extends Error {
  /** Classification the runner reads to bucket the failure as `"content-policy"`. */
  readonly kind: "content-policy" = "content-policy";

  /**
   * Creates a content-policy provider error.
   *
   * @param message - Human-readable message (never the key or the prompt).
   * @example
   * ```ts
   * new FlaggedProviderError("[ai] apimodels flagged the request (content moderation).\n  Change the prompt or the inputs.");
   * ```
   */
  constructor(message: string) {
    super(message);
    this.name = "FlaggedProviderError";
  }
}
