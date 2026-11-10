/**
 * @file dialogue capability contract — task-owned; providers implement this.
 *
 * Self-contained by design (spec/03 §3, spec/07 — "small structural
 * duplication across task contracts is the ratified price of true task
 * ownership"): it imports no plugin module, so this file alone defines what a
 * "dialogue provider" is. Provider plugins type-import it via
 * `import type { DialogueHandler } from "../dialogue/contract"` without a
 * `depends` edge.
 */

/**
 * One spoken line of a dialogue scene.
 *
 * @example
 * ```ts
 * const line: DialogueLine = { id: "ep02-signAlice-ru", text: "[tense] I never signed it!", voice: "TPIitICAZ8CqlGZ81AKm" };
 * ```
 */
export type DialogueLine = {
  /** File name of this line's cut (no extension, no slash), e.g. "ep02-signAlice-ru". Optional. */
  id?: string;
  /** Text to speak; audio tags are allowed for models that take them ("[tense] ..."). */
  text: string;
  /** Provider-scoped voice id. */
  voice: string;
};

/**
 * Voice settings applied to the whole scene.
 *
 * @example
 * ```ts
 * const settings: DialogueSettings = { stability: 0.5, similarity: 0.75 };
 * ```
 */
export type DialogueSettings = {
  /** 0..1, how steady the delivery is. */
  stability?: number;
  /** 0..1, how close to the reference voice. */
  similarity?: number;
};

/**
 * A multi-speaker scene generation request: ordered lines, spoken in one provider request.
 *
 * @example
 * ```ts
 * const request: DialogueRequest = {
 *   model: "eleven_v4",
 *   language: "ru",
 *   lines: [{ id: "signAlice", text: "[tense] I never signed it!", voice: "TPIitICAZ8CqlGZ81AKm" }]
 * };
 * ```
 */
export type DialogueRequest = {
  /** The lines in speaking order. */
  lines: DialogueLine[];
  /** Provider-scoped model alias; the provider default when absent (elevenlabs: eleven_v4). */
  model?: string;
  /** BCP-47 / ISO 639-1 language hint. */
  language?: string;
  /** Scene-wide voice settings. */
  settings?: DialogueSettings;
  /** Seed for repeatable takes, where the provider supports it. */
  seed?: number;
  /** Provider-scoped output format code, e.g. "mp3_44100_192" or "wav_44100". */
  outputFormat?: string;
  // Open record: keys are provider-scoped and documented per provider README (same as music).
  /** Raw provider fields, spread last into the provider's request. */
  params?: Record<string, unknown>;
};

/**
 * The cut window of one line inside the scene audio.
 *
 * @example
 * ```ts
 * const timing: DialogueLineTiming = { index: 0, id: "signAlice", startMs: 0, endMs: 2300 };
 * ```
 */
export type DialogueLineTiming = {
  /** Index of the line in `DialogueRequest.lines`. */
  index: number;
  /** The line's `id`, when it had one. */
  id?: string;
  /** Start of the cut, ms from the scene start. */
  startMs: number;
  /** End of the cut, ms from the scene start. */
  endMs: number;
};

/**
 * The result of one scene generation: the whole mix plus one audio file per line.
 * Structurally a runner `HandlerResult` (`audio` + `mimeType` + `outputs`), so the
 * runner stores and exports every output with no dialogue-specific code.
 *
 * @example
 * ```ts
 * const scene: DialogueResult = {
 *   audio: new Uint8Array(),
 *   mimeType: "audio/mpeg",
 *   costUsd: 0.4,
 *   outputs: [{ bytes: new Uint8Array(), mimeType: "audio/mpeg" }],
 *   lines: []
 * };
 * ```
 */
export type DialogueResult = {
  /** The whole scene's audio. */
  audio: Uint8Array;
  /** MIME type of `audio`, e.g. "audio/mpeg". */
  mimeType: string;
  /** Actual cost of this generation, in US dollars. */
  costUsd: number;
  /** `outputs[0]` is the whole scene; then one entry per line that has speech, in line order. */
  outputs: { bytes: Uint8Array; mimeType: string; name?: string }[];
  /** The cut window of each line that has a file, ms from the scene start. */
  lines: DialogueLineTiming[];
  // Open record: keys are provider-scoped and documented per provider README (same as music).
  /** Metadata only, never a payload echo (e.g. model, requestId). */
  meta?: Record<string, unknown>;
};

/**
 * The capability contract a dialogue provider plugin implements and registers
 * with the registry under the "dialogue" task. A handler has `estimate` and
 * `execute`; there is no async job form. Owned by this plugin — see
 * `README.md`.
 *
 * @example
 * ```ts
 * const handler: DialogueHandler = {
 *   estimate: request => ({ usd: request.lines.reduce((sum, line) => sum + line.text.length, 0) * 0.0001 }),
 *   execute: async () => ({ audio: new Uint8Array(), mimeType: "audio/mpeg", costUsd: 0.1, outputs: [], lines: [] })
 * };
 * ```
 */
export type DialogueHandler = {
  /**
   * Estimates the cost of `request` without executing it — used by the
   * runner's budget gate and by `app.dialogue.estimate()`.
   *
   * @param request - The request to estimate.
   * @returns The estimated cost in US dollars.
   */
  estimate(request: DialogueRequest): { usd: number };
  /**
   * Executes `request` in one call, returning the whole scene, one file per line and the actual cost.
   *
   * @param request - The request to execute.
   * @param opts - Execution options.
   * @param opts.signal - Abort signal for cancelling the in-flight request.
   * @returns The generation result.
   */
  execute(request: DialogueRequest, opts: { signal?: AbortSignal }): Promise<DialogueResult>;
};
