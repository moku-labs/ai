/**
 * @file runner retry — error taxonomy + backoff. Owns the contractual
 * classification: retry ONLY 5xx/429/timeout/network; 4xx (except 429) is
 * terminal `failed`; content-policy is terminal `flagged`, never re-queued;
 * an error with no hint is `unknown` and terminal.
 */
import type { ErrorClass } from "../journal/types";
import type { ProviderErrorHint } from "./types";

/** Error classes the pipeline retries (all others are terminal). */
const RETRYABLE_CLASSES: ReadonlySet<ErrorClass> = new Set([
  "http-5xx",
  "http-429",
  "timeout",
  "network"
]);

/** Minimum jitter factor applied to the exponential backoff base delay. */
const MIN_JITTER_FACTOR = 0.5;

/**
 * Type guard narrowing an unknown thrown value to the optional structural
 * hint a provider handler may attach ({@link ProviderErrorHint}).
 *
 * @param error - The thrown value, from a `catch` clause.
 * @returns Whether `error` is a non-null object that may carry hint fields.
 * @example
 * ```ts
 * const hasHint = isProviderErrorHint(error);
 * ```
 */
function isProviderErrorHint(error: unknown): error is ProviderErrorHint {
  return typeof error === "object" && error !== null;
}

/**
 * Whether the pipeline should retry an error of this class. `http-5xx`,
 * `http-429`, `timeout`, and `network` are retryable; `http-4xx` and
 * `content-policy` are terminal.
 *
 * @param errorClass - The classified error class.
 * @returns True when the pipeline should re-queue the item for another attempt.
 * @example
 * ```ts
 * isRetryableErrorClass("http-5xx"); // => true
 * ```
 */
export function isRetryableErrorClass(errorClass: ErrorClass): boolean {
  return RETRYABLE_CLASSES.has(errorClass);
}

/**
 * Classifies a thrown provider error into the journal error taxonomy.
 * Reads the optional {@link ProviderErrorHint} fields (`kind`/`status`) a
 * handler may attach to its thrown error; falls back to `"unknown"` when
 * neither is present. `"unknown"` is terminal: a programming error (a
 * `TypeError`, a wrong request shape) must never re-run a paid job.
 * Providers tag real transport failures with `kind: "network"`.
 *
 * @param error - The thrown error.
 * @returns The error's taxonomy class.
 * @example
 * ```ts
 * const errorClass = classifyError(error);
 * ```
 */
export function classifyError(error: unknown): ErrorClass {
  if (!isProviderErrorHint(error)) return "unknown";
  if (error.kind === "content-policy") return "content-policy";
  if (error.kind === "timeout") return "timeout";
  if (error.kind === "network") return "network";
  if (error.status === 429) return "http-429";
  if (typeof error.status === "number" && error.status >= 500) return "http-5xx";
  if (typeof error.status === "number" && error.status >= 400) return "http-4xx";
  return "unknown";
}

/**
 * Reads a provider-supplied Retry-After hint (ms) off a thrown error, when present.
 *
 * @param error - The thrown error.
 * @returns The hinted delay in ms, or undefined when no hint was attached.
 * @example
 * ```ts
 * const retryAfterMs = retryAfterMsOf(error);
 * ```
 */
export function retryAfterMsOf(error: unknown): number | undefined {
  return isProviderErrorHint(error) ? error.retryAfterMs : undefined;
}

/**
 * Computes the backoff delay before the next attempt: exponential in the
 * attempt number, jittered between 50% and 100% of the computed value, then
 * overridden by a provider `Retry-After` hint when that hint is larger.
 *
 * @param attempt - 1-based attempt number that just failed.
 * @param baseMs - Configured base backoff, ms.
 * @param retryAfterMs - Provider-supplied Retry-After, ms (optional).
 * @returns The delay, in ms, to wait before the next attempt.
 * @example
 * ```ts
 * const delay = backoffMs(1, 1_000);
 * ```
 */
export function backoffMs(attempt: number, baseMs: number, retryAfterMs?: number): number {
  const exponential = baseMs * 2 ** Math.max(0, attempt - 1);
  // eslint-disable-next-line sonarjs/pseudo-random -- backoff jitter, not security
  const jitterFactor = MIN_JITTER_FACTOR + Math.random() * (1 - MIN_JITTER_FACTOR);
  const jittered = Math.round(exponential * jitterFactor);
  if (retryAfterMs !== undefined && retryAfterMs > jittered) return retryAfterMs;
  return jittered;
}
