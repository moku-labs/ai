/**
 * @file claude provider plugin — the runner-compatible provider error classes.
 * Runtime provider error classes — values; `types.ts` stays types-only.
 */

/**
 * Retryable failure: the CLI ran past `timeoutMs`. Carries `kind`, the
 * field the runner's `classifyError` reads to bucket it as retryable.
 */
export class RetryableProviderError extends Error {
  /** Retry classification read by the runner's classifyError. */
  readonly kind: "timeout" | "network";

  /**
   * Creates a retryable provider error.
   *
   * @param message - Human-readable two-line message (never the prompt).
   * @param kind - Retry classification read by the runner.
   */
  constructor(message: string, kind: "timeout" | "network") {
    super(message);
    this.name = "RetryableProviderError";
    this.kind = kind;
  }
}

/**
 * Terminal failure: the CLI could not start, exited without a JSON result,
 * reported an error, wrote no answer, or answered off-schema. Has no `kind`
 * and no `status`, so the runner buckets it as "unknown" (never retried)
 * and promptGen never falls back on it.
 */
export class TerminalProviderError extends Error {
  /**
   * Creates a terminal provider error.
   *
   * @param message - Human-readable two-line message (never the prompt).
   */
  constructor(message: string) {
    super(message);
    this.name = "TerminalProviderError";
  }
}
