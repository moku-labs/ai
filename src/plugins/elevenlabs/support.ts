/**
 * @file elevenlabs handler support — the two steps every per-task handler
 * shares: reading the API key through `ctx.env`, and reducing a thrown error
 * to redacted, loggable fields. Per-task submodules never import each other,
 * so they share these through this root module.
 */
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "./errors";
import type { ElevenlabsContext } from "./types";

/**
 * Loggable fields extracted from a thrown error — status code + error class only, never request text.
 *
 * @example
 * ```ts
 * const failure: RedactedFailure = { errorType: "terminal", status: 400 };
 * ```
 */
export type RedactedFailure = {
  /** Which provider error class was thrown, or "unknown". */
  errorType: string;
  /** HTTP status code, when the error carries one. */
  status?: number | undefined;
  /** Failure kind (timeout, network, content-policy), when the error carries one. */
  kind?: string | undefined;
};

/**
 * Resolves the API key via `ctx.env`, throwing the pinned two-line "not
 * set" error (interpolating the configured env var name) when unset.
 *
 * @param ctx - Plugin context (for `config.apiKeyEnv` + `ctx.env`).
 * @returns The resolved API key.
 * @throws {Error} The pinned two-line "API key is not set" error.
 */
export function resolveApiKey(ctx: ElevenlabsContext): string {
  const apiKey = ctx.env.get(ctx.config.apiKeyEnv);
  if (apiKey === undefined) {
    throw new Error(
      `[ai] ${ctx.config.apiKeyEnv} is not set.\n  Export it or set config.apiKeyEnv to the variable that holds your key.`
    );
  }
  return apiKey;
}

/**
 * Extracts redacted, loggable fields from a thrown error: status code and
 * error class only, never the original error message (which may echo
 * provider response text) — the redaction rule (spec/10).
 *
 * @param error - The thrown error.
 * @returns The redacted fields to pass to `ctx.log`.
 * @example
 * ```ts
 * redactedFailureOf(new TerminalProviderError("[ai] ElevenLabs rejected the request (HTTP 400).", 400));
 * // => { errorType: "terminal", status: 400 }
 * ```
 */
export function redactedFailureOf(error: unknown): RedactedFailure {
  if (error instanceof RetryableProviderError) {
    return { errorType: "retryable", status: error.status, kind: error.kind };
  }
  if (error instanceof TerminalProviderError) {
    return { errorType: "terminal", status: error.status };
  }
  if (error instanceof FlaggedProviderError) {
    return { errorType: "flagged", kind: error.kind };
  }
  return { errorType: "unknown" };
}
