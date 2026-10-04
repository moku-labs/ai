/**
 * @file sfx capability contract — task-owned; providers implement this.
 *
 * Self-contained by design (spec/03 §3, spec/07 — "small structural
 * duplication across task contracts is the ratified price of true task
 * ownership"): it imports no plugin module, so this file alone defines what an
 * "sfx provider" is. Provider plugins type-import it via
 * `import type { SfxHandler } from "../sfx/contract"` without a `depends` edge.
 */

/**
 * A single sound-effect generation request. `model` is required: the runner
 * hashes the input as written, so a model defaulted inside the provider would not
 * be part of the artifact key and a changed default would reuse another model's audio.
 *
 * @example
 * ```ts
 * const request: SfxRequest = { prompt: "coin pickup, bright 8-bit chime", model: "eleven_text_to_sound_v2", durationMs: 600 };
 * ```
 */
export type SfxRequest = {
  /** What the sound is, e.g. "coin pickup, bright 8-bit chime". */
  prompt: string;
  /** Provider-scoped model alias, e.g. "eleven_text_to_sound_v2". Required: it is part of the artifact key. */
  model: string;
  /** Length in ms. Omitted means the provider picks the length. Providers check their own range. */
  durationMs?: number;
  /** 0..1, how literally the prompt is followed. */
  promptInfluence?: number;
  /** Ask for a seamless loop, when the model supports it. */
  loop?: boolean;
  /** Provider params; each provider documents the keys it reads. */
  params?: Record<string, unknown>;
};

/**
 * The result of one sound-effect generation: mp3 bytes plus enough metadata
 * to journal cost and identity without re-deriving them. Always mp3: the game
 * engine accepts mp3 only, so a handler never returns another format.
 *
 * @example
 * ```ts
 * const result: SfxResult = { audio: new Uint8Array(), mimeType: "audio/mpeg", costUsd: 0.12 };
 * ```
 */
export type SfxResult = {
  /** The generated mp3 bytes. */
  audio: Uint8Array;
  /** Always "audio/mpeg". */
  mimeType: "audio/mpeg";
  /** Actual cost of this generation, in US dollars. */
  costUsd: number;
  /** Metadata only, never a payload echo (e.g. model, endpoint, requestId, durationMs). */
  meta?: Record<string, unknown>;
};

/**
 * The capability contract an sfx provider plugin implements and registers
 * with the registry under the "sfx" task. A handler has `estimate` and
 * `execute`; there is no async job form. Owned by this plugin — see spec/15
 * and `README.md`.
 *
 * @example
 * ```ts
 * const handler: SfxHandler = {
 *   estimate: request => ({ usd: Math.ceil((request.durationMs ?? 1000) / 1000) * 0.12 }),
 *   execute: async () => ({ audio: new Uint8Array(), mimeType: "audio/mpeg", costUsd: 0.12 })
 * };
 * ```
 */
export type SfxHandler = {
  /**
   * Estimates the cost of `request` without executing it — used by the
   * runner's budget gate and by `app.sfx.estimate()`.
   *
   * @param request - The request to estimate.
   * @returns The estimated cost in US dollars.
   */
  estimate(request: SfxRequest): { usd: number };
  /**
   * Executes `request` in one call, returning the mp3 audio and its actual cost.
   *
   * @param request - The request to execute.
   * @param opts - Execution options.
   * @param opts.signal - Abort signal for cancelling the in-flight request.
   * @returns The generation result.
   */
  execute(request: SfxRequest, opts: { signal?: AbortSignal }): Promise<SfxResult>;
};
