/**
 * @file voiceover capability contract — task-owned; providers implement this.
 *
 * Self-contained by design (spec/07 — "small structural duplication across
 * task contracts is the ratified price of true task ownership"): no shared
 * base type is imported from elsewhere, so this file alone defines what a
 * "voiceover provider" is. Provider plugins type-import these via
 * `import type { VoiceoverHandler } from "../voiceover/contract"`.
 */

/**
 * Per-request voice settings. Every field is optional; a provider maps the
 * ones it supports onto its own parameter names and ignores the rest.
 *
 * @example
 * ```ts
 * const settings: VoiceSettings = { stability: 0.4, similarity: 0.8, speed: 1.1 };
 * ```
 */
export type VoiceSettings = {
  /** Delivery stability, 0 (more expressive) to 1 (more consistent). */
  stability?: number;
  /** How closely the output follows the original voice, 0 to 1. */
  similarity?: number;
  /** Style exaggeration, 0 to 1. */
  style?: number;
  /** Boosts similarity to the original speaker, at some latency cost. */
  speakerBoost?: boolean;
  /** Speaking rate multiplier (1 is normal speed). */
  speed?: number;
};

/**
 * A single voiceover generation request: the text to speak, the
 * provider-scoped voice, and optional language/model/format hints plus
 * resolved template-pack params.
 *
 * @example
 * ```ts
 * const request: VoiceoverRequest = { text: "Hello, world!", voice: "en-US-1" };
 * ```
 */
export type VoiceoverRequest = {
  /** The text to synthesize. */
  text: string;
  /** Provider-scoped voice id or name (e.g. "en-US-1", a provider's voice UUID). */
  voice: string;
  /** BCP-47 language tag (e.g. "en-US"), for providers that need an explicit hint. */
  language?: string;
  /** Provider-scoped model id (e.g. "eleven_multilingual_v2"). */
  model?: string;
  /** Output audio container format. */
  format?: "mp3" | "wav" | "ogg";
  /** Per-request voice settings; providers map them to their own names and ignore what they lack. */
  settings?: VoiceSettings;
  /** Integer >= 0 for best-effort reproducibility; providers without seed support ignore it. */
  seed?: number;
  /** Text spoken before this line, giving the provider intonation context. */
  previousText?: string;
  /** Text spoken after this line, giving the provider intonation context. */
  nextText?: string;
  /** Provider-scoped output encoding (e.g. "mp3_44100_192"); wins over `format` when both are set. */
  outputFormat?: string;
  /** Resolved pack values merged upstream — providers receive final text/params only. */
  params?: Record<string, unknown>;
};

/**
 * The result of one voiceover generation: raw audio bytes plus enough
 * metadata to journal cost and identity without ever re-deriving them.
 *
 * @example
 * ```ts
 * const result: VoiceoverResult = {
 *   audio: new Uint8Array(),
 *   mimeType: "audio/mpeg",
 *   costUsd: 0.0021
 * };
 * ```
 */
export type VoiceoverResult = {
  /** The synthesized audio bytes. */
  audio: Uint8Array;
  /** MIME type of `audio` (`audio/mpeg` | `audio/wav` | `audio/ogg`). */
  mimeType: string;
  /** Actual cost of this generation, in US dollars. */
  costUsd: number;
  /** Metadata only, never a payload echo (e.g. durationMs, characters, model). */
  meta?: Record<string, unknown>;
};

/**
 * The capability contract a voiceover provider plugin implements and
 * registers with the registry under the "voiceover" task. Owned by this
 * plugin — see spec/07 and `README.md`.
 *
 * @example
 * ```ts
 * const handler: VoiceoverHandler = {
 *   estimate: request => ({ usd: request.text.length * 0.00003 }),
 *   execute: async request => ({ audio: new Uint8Array(), mimeType: "audio/mpeg", costUsd: 0 })
 * };
 * ```
 */
export type VoiceoverHandler = {
  /**
   * Estimates the cost of `request` without executing it — used by the
   * runner's budget gate and by `app.voiceover.estimate()`.
   *
   * @param request - The request to estimate.
   * @returns The estimated cost in US dollars.
   * @example
   * ```ts
   * handler.estimate({ text: "hi", voice: "en-US-1" }); // => { usd: 0.00006 }
   * ```
   */
  estimate(request: VoiceoverRequest): { usd: number };
  /**
   * Executes `request`, returning the synthesized audio and its actual cost.
   *
   * @param request - The request to execute.
   * @param opts - Execution options.
   * @param opts.signal - Abort signal for cancelling the in-flight request.
   * @returns The generation result.
   * @example
   * ```ts
   * await handler.execute({ text: "hi", voice: "en-US-1" }, {});
   * ```
   */
  execute(request: VoiceoverRequest, opts: { signal?: AbortSignal }): Promise<VoiceoverResult>;
};
