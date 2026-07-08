/**
 * @file voiceover plugin — type definitions (re-exports the contract).
 */
import type { VoiceoverRequest, VoiceoverResult } from "./contract";

export type { VoiceoverHandler, VoiceoverRequest, VoiceoverResult } from "./contract";

/**
 *
 */
export type Config = {
  /** Provider used when a request doesn't name one. */
  defaultProvider: string;
  /** Default output format hint. */
  defaultFormat: "mp3" | "wav" | "ogg";
};

/**
 *
 */
export type VoiceoverApi = {
  generate(
    request: VoiceoverRequest,
    opts?: { signal?: AbortSignal; provider?: string }
  ): Promise<VoiceoverResult>;
  estimate(request: VoiceoverRequest, opts?: { provider?: string }): { usd: number };
  providers(): string[];
};
