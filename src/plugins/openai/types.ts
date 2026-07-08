/**
 * @file openai provider plugin — types (structural OpenaiClient) + error classes.
 */
export type Config = {
  /** Env var name holding the API key. */
  apiKeyEnv: string;
  /** Optional API base URL override. */
  baseUrl?: string;
  /** Default models per capability. */
  models: { tts: string; chat: string };
  /** Request timeout, ms. */
  timeoutMs: number;
  /** Price overrides by model. */
  priceOverrides: Record<
    string,
    { inputPerM?: number; outputPerM?: number; ttsPerMChars?: number }
  >;
};

/** STRUCTURAL alias covering exactly the SDK surface the handlers call. */
export type OpenaiClient = {
  audio: {
    speech: {
      create(params: Record<string, unknown>): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
    };
  };
  chat: {
    completions: {
      create(params: Record<string, unknown>): Promise<{
        choices: Array<{ message: { content: string | null } }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      }>;
    };
  };
};

/**
 *
 */
export type PriceTable = Record<
  string,
  { inputPerM?: number; outputPerM?: number; ttsPerMChars?: number }
>;

/**
 *
 */
export type State = {
  /** Lazily-created SDK client (constructed on first use, not at init). */
  client: OpenaiClient | null;
  /** Effective price table (bundled merged with overrides). */
  prices: PriceTable | null;
};

/**
 *
 */
export type OpenaiApi = {
  info(): { provider: "openai"; configured: boolean; models: { tts: string; chat: string } };
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

/** Content-policy rejection/refusal — terminal `flagged`, never re-queued. */
export class FlaggedProviderError extends Error {
  readonly errorClass = "content-policy";
}
