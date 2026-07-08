/**
 * @file elevenlabs provider plugin — types + provider error classes.
 */
export type Config = {
  /** Env var name holding the API key (read via ctx.env at request time). */
  apiKeyEnv: string;
  /** API base URL. */
  baseUrl: string;
  /** Default model. */
  defaultModel: string;
  /** Request timeout, ms. */
  timeoutMs: number;
  /** Price-per-character overrides by model. */
  priceOverrides: Record<string, number>;
};

/**
 *
 */
export type State = {
  /** Effective price table (bundled merged with overrides); computed at first use. */
  prices: Record<string, number> | null;
};

/**
 *
 */
export type ElevenlabsApi = {
  info(): { provider: "elevenlabs"; configured: boolean; models: string[] };
};

/** Retryable transport/provider failure (5xx/429/timeout/network). */
export class RetryableProviderError extends Error {
  readonly errorClass: "http-5xx" | "http-429" | "timeout" | "network";
  readonly retryAfterMs: number | undefined;

  /**
   * Creates a retryable provider error.
   *
   * @param message - Redacted human-readable message (never request text).
   * @param errorClass - Retryable taxonomy bucket.
   * @param retryAfterMs - Provider-supplied Retry-After delay, ms.
   * @example
   * ```ts
   * throw new RetryableProviderError("[ai] rate limited.", "http-429", 1_000);
   * ```
   */
  constructor(
    message: string,
    errorClass: RetryableProviderError["errorClass"],
    retryAfterMs?: number
  ) {
    super(message);
    this.errorClass = errorClass;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Deterministic 4xx failure — never retried. */
export class TerminalProviderError extends Error {
  readonly errorClass = "http-4xx";
}

/** Content-policy rejection — terminal `flagged` state, never re-queued. */
export class FlaggedProviderError extends Error {
  readonly errorClass = "content-policy";
}
