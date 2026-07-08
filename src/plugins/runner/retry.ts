/**
 * @file runner retry — error taxonomy + backoff skeleton.
 */
import type { ErrorClass } from "../journal/types";

/**
 * Classifies a thrown provider error into the journal error taxonomy.
 *
 * @param _error - The thrown error.
 * @example
 * ```ts
 * const errorClass = classifyError(error);
 * ```
 */
export function classifyError(_error: unknown): ErrorClass {
  throw new Error("not implemented");
}

/**
 * Computes the backoff delay before the next attempt (exponential with
 * jitter; Retry-After takes precedence when present).
 *
 * @param _attempt - 1-based attempt number that just failed.
 * @param _baseMs - Configured base backoff, ms.
 * @param _retryAfterMs - Provider-supplied Retry-After, ms (optional).
 * @example
 * ```ts
 * const delay = backoffMs(1, 1_000);
 * ```
 */
export function backoffMs(_attempt: number, _baseMs: number, _retryAfterMs?: number): number {
  throw new Error("not implemented");
}
