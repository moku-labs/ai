/**
 * @file apimodels HTTP vocabulary — the statuses and the failCode that more
 * than one module of this plugin reads, and the one terminal-400 refusal.
 * Declared once here; `client.ts`, `upload.ts`, `assets.ts`, `prices.ts` and
 * `video/*` import them.
 */
import { TerminalProviderError } from "./errors";

/** Status of a request refused for good: terminal, retrying cannot help. */
export const BAD_REQUEST = 400;

/** Status of a missing or bad key. */
export const UNAUTHORIZED = 401;

/** Status apimodels answers when the account balance is too low. */
export const PAYMENT_REQUIRED = 402;

/** Status apimodels answers for a key it refuses. */
const FORBIDDEN = 403;

/** Status of a rate limit: the runner retries after `Retry-After`. */
export const RATE_LIMITED = 429;

/** Status of a failure the runner should retry by submitting (or polling) again: a 5xx, so it is retryable. */
export const RETRY_STATUS = 503;

/** Statuses apimodels answers for a bad or missing key. */
export const AUTH_STATUSES: ReadonlySet<number> = new Set([UNAUTHORIZED, FORBIDDEN]);

/** failCode apimodels uses for a content-moderation rejection. */
export const CONTENT_MODERATION = "CONTENT_MODERATION";

/** Milliseconds per second: a `Retry-After` in seconds becomes a delay in ms. */
export const MS_PER_SECOND = 1000;

/**
 * A terminal 400 refusal: a request, or its `params.assets`, that this plugin
 * will not send.
 *
 * @param message - The two-line message.
 * @returns The error to throw.
 * @example
 * ```ts
 * refusal("[ai] x.\n  y.").status; // => 400
 * ```
 */
export function refusal(message: string): TerminalProviderError {
  return new TerminalProviderError(message, BAD_REQUEST);
}
