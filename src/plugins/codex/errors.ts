/**
 * @file codex provider plugin — runtime provider error classes — values;
 * `types.ts` stays types-only. The runner-compatible error taxonomy:
 * `RetryableProviderError` (timeout) and `TerminalProviderError` (everything else).
 */

/**
 * Retryable failure: the CLI ran past `timeoutMs`. Carries `kind`, the
 * field the runner's `classifyError` reads to bucket it as retryable.
 */
export class RetryableProviderError extends Error {
  readonly kind: "timeout" | "network";

  /**
   * Creates a retryable provider error.
   *
   * @param message - Human-readable message (never the prompt).
   * @param kind - Retry classification read by the runner.
   * @example
   * ```ts
   * throw new RetryableProviderError("[ai] Codex timed out.", "timeout");
   * ```
   */
  constructor(message: string, kind: "timeout" | "network") {
    super(message);
    this.name = "RetryableProviderError";
    this.kind = kind;
  }
}

/**
 * Terminal failure: CLI missing, non-zero exit, or no image written. Has no
 * `kind` and no `status`, so the runner buckets it as "unknown" (terminal,
 * never retried).
 */
export class TerminalProviderError extends Error {
  /**
   * Creates a terminal provider error.
   *
   * @param message - Human-readable two-line message (never the prompt).
   * @example
   * ```ts
   * throw new TerminalProviderError("[ai] Codex exited with code 1.\n  Run codex exec by hand.");
   * ```
   */
  constructor(message: string) {
    super(message);
    this.name = "TerminalProviderError";
  }
}
