/**
 * @file voiceover capability contract — task-owned; providers implement this.
 */
export type VoiceoverRequest = {
  text: string;
  voice: string;
  language?: string;
  model?: string;
  format?: "mp3" | "wav" | "ogg";
  params?: Record<string, unknown>;
};

/**
 *
 */
export type VoiceoverResult = {
  audio: Uint8Array;
  mimeType: string;
  costUsd: number;
  meta?: Record<string, unknown>;
};

/**
 *
 */
export type VoiceoverHandler = {
  estimate(request: VoiceoverRequest): { usd: number };
  execute(request: VoiceoverRequest, opts: { signal?: AbortSignal }): Promise<VoiceoverResult>;
};
