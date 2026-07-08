/**
 * @file openai lazy SDK client factory skeleton (structural OpenaiClient seam).
 */
import type { OpenaiClient } from "./types";

/**
 * Creates the OpenAI SDK client lazily (constructed on first use, not at init).
 *
 * @param _options - API key, optional base URL, and request timeout.
 * @param _options.apiKey - API key read via ctx.env.
 * @param _options.baseUrl - Optional API base URL override.
 * @param _options.timeoutMs - Request timeout, ms.
 * @example
 * ```ts
 * const client = createOpenaiClient({ apiKey, timeoutMs: 60_000 });
 * ```
 */
export function createOpenaiClient(_options: {
  apiKey: string;
  baseUrl?: string;
  timeoutMs: number;
}): OpenaiClient {
  throw new Error("not implemented");
}
