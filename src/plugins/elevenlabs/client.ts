/**
 * @file elevenlabs thin fetch client skeleton (global fetch — Node ≥24 and Bun).
 */

/** Options for one ElevenLabs API request. */
export type ElevenlabsRequestOptions = {
  baseUrl: string;
  path: string;
  apiKey: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
};

/**
 * Performs one ElevenLabs API request and returns the binary response body
 * (throws the provider error taxonomy on failure).
 *
 * @param _options - Request options (URL, key, body, timeout, signal).
 * @example
 * ```ts
 * const audio = await elevenlabsRequest(options);
 * ```
 */
export function elevenlabsRequest(_options: ElevenlabsRequestOptions): Promise<Uint8Array> {
  throw new Error("not implemented");
}
