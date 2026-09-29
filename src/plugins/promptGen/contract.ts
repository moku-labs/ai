/**
 * @file prompt-gen capability contract — task-owned; providers implement this.
 */

/**
 * A one-off text-generation request. Providers map/clamp `temperature` and
 * `params` as needed for their own API.
 *
 * @example
 * ```ts
 * const request: PromptGenRequest = { prompt: "Describe a sunset over the ocean." };
 * ```
 */
export type PromptGenRequest = {
  prompt: string;
  system?: string;
  model?: string;
  /** Provider maps/clamps as needed. */
  temperature?: number;
  params?: Record<string, unknown>;
};

/**
 * The result of a prompt-gen request: the generated text and its cost, plus
 * optional provider metadata.
 *
 * @example
 * ```ts
 * const result: PromptGenResult = { text: "A fiery orange sunset.", costUsd: 0.0002 };
 * ```
 */
export type PromptGenResult = {
  text: string;
  costUsd: number;
  /** Token counts, model — metadata only. */
  meta?: Record<string, unknown>;
};

/**
 * The handler contract a prompt-gen provider plugin registers with
 * `registry` under the `"prompt-gen"` task. Provider plugins `import type`
 * this to implement it; `promptGen` performs the one audited cast to this
 * type at its own `resolve()` call site (spec/09 R9).
 *
 * @example
 * ```ts
 * const handler: PromptGenHandler = {
 *   estimate: request => ({ usd: request.prompt.length * 0.00001 }),
 *   execute: async request => ({ text: request.prompt, costUsd: 0 })
 * };
 * ```
 */
export type PromptGenHandler = {
  /**
   * Estimates the cost of executing `request`, without performing it.
   *
   * @param request - The prompt-gen request to estimate.
   * @returns The estimated cost in USD.
   */
  estimate(request: PromptGenRequest): { usd: number };
  /**
   * Executes `request` against the provider.
   *
   * @param request - The prompt-gen request to execute.
   * @param opts - Execution options.
   * @param opts.signal - Optional abort signal to cancel the request.
   * @returns The generated result.
   */
  execute(request: PromptGenRequest, opts: { signal?: AbortSignal }): Promise<PromptGenResult>;
};

/** HTTP statuses that mean "this provider cannot serve now": auth, payment, forbidden, rate limit. */
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([401, 402, 403, 429]);

/**
 * Thrown by a prompt-gen provider that cannot serve right now: its binary is
 * missing, it is not logged in, or it hit a plan or rate limit. `promptGen`
 * moves to the next provider of its `fallback` chain on this error only; any
 * other error means the provider answered badly and is rethrown at once.
 * Plugin-free (no plugin import), so providers value-import it without a
 * `depends` edge.
 *
 * @example
 * ```ts
 * // A local CLI handler whose spawn failed with ENOENT: promptGen tries the next provider.
 * throw new PromptGenUnavailableError(
 *   "[ai] Claude CLI not found: claude.\n  Install Claude Code or set claude.bin.",
 *   "missing"
 * ); // error.unavailable === true, error.reason === "missing"
 * ```
 */
export class PromptGenUnavailableError extends Error {
  /** Marker read by {@link isPromptGenUnavailable}; survives a structural copy of the error. */
  readonly unavailable = true;
  /** Why the provider cannot serve: binary missing, not logged in, or plan/rate limit. */
  readonly reason: "missing" | "auth" | "limit";

  /**
   * Creates the error with the provider's two-line message.
   *
   * @param message - Two-line `[ai] …` message; never contains the prompt.
   * @param reason - Why the provider cannot serve.
   */
  constructor(message: string, reason: "missing" | "auth" | "limit") {
    super(message);
    this.name = "PromptGenUnavailableError";
    this.reason = reason;
  }
}

/**
 * Tells whether an error means "provider unavailable" rather than "provider
 * failed": `error.unavailable === true` (a {@link PromptGenUnavailableError}),
 * or a numeric `error.status` of 401, 402, 403 or 429 (so HTTP providers such
 * as openai and fal take part in the fallback chain).
 *
 * @param error - Any thrown value.
 * @returns True when the fallback chain may move to the next provider.
 * @example
 * ```ts
 * // A consumer's own retry loop, reusing promptGen's switch rule.
 * isPromptGenUnavailable(new PromptGenUnavailableError("[ai] Codex CLI is not logged in.\n  Run codex login, or use another provider.", "auth")); // true
 * isPromptGenUnavailable({ status: 429 }); // true
 * isPromptGenUnavailable({ status: 500 }); // false
 * ```
 */
export function isPromptGenUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("unavailable" in error && error.unavailable === true) return true;

  return (
    "status" in error && typeof error.status === "number" && UNAVAILABLE_STATUSES.has(error.status)
  );
}
