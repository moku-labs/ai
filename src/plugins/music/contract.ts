/**
 * @file music capability contract — task-owned; providers implement this.
 *
 * Self-contained by design (spec/03 §3, spec/07 — "small structural
 * duplication across task contracts is the ratified price of true task
 * ownership"): it imports no plugin module, so this file alone defines what a
 * "music provider" is. Provider plugins type-import it via
 * `import type { MusicHandler } from "../music/contract"` without a `depends` edge.
 */

/**
 * One section of a composition plan: its text, length and style tags.
 *
 * @example
 * ```ts
 * const chunk: MusicChunk = { text: "build", durationMs: 40_000, styles: ["synthwave"], avoid: ["vocals"] };
 * ```
 */
export type MusicChunk = {
  /** Lyrics or section description. */
  text: string;
  /** Section length, ms. */
  durationMs: number;
  /** Positive style tags. */
  styles: string[];
  /** Negative style tags. */
  avoid?: string[];
};

/**
 * A single music generation request. `model` is required: the runner hashes the
 * input as written, so a model defaulted inside the provider would not be part of
 * the artifact key and a changed default would reuse another model's audio.
 *
 * @example
 * ```ts
 * const request: MusicRequest = { prompt: "tense synth pulse", model: "elevenlabs-music-v2.5", lengthMs: 60_000 };
 * ```
 */
export type MusicRequest = {
  /** Overall music prompt. */
  prompt: string;
  /** Provider-scoped model alias, e.g. "elevenlabs-music-v2.5". Required: price, endpoint and output depend on it. */
  model: string;
  /** Track length, ms. */
  lengthMs: number;
  /** Composition plan; a model without plans rejects it (provider rule, never dropped silently). */
  chunks?: MusicChunk[];
  /** Seed, when the model takes one. */
  seed?: number;
  /** Provider params; each provider documents which keys it reads (fal reads none). */
  params?: Record<string, unknown>;
};

/**
 * The result of one music generation: raw audio bytes plus enough metadata
 * to journal cost and identity without re-deriving them.
 *
 * @example
 * ```ts
 * const result: MusicResult = { audio: new Uint8Array(), mimeType: "audio/mpeg", costUsd: 0.8 };
 * ```
 */
export type MusicResult = {
  /** The generated audio bytes. */
  audio: Uint8Array;
  /** MIME type of `audio`, e.g. "audio/mpeg". */
  mimeType: string;
  /** Actual cost of this generation, in US dollars. */
  costUsd: number;
  /** Metadata only, never a payload echo (e.g. model, endpoint, requestId, lengthMs). */
  meta?: Record<string, unknown>;
};

/**
 * One poll of an async music job: still running, finished with a result,
 * or failed with the provider's error.
 *
 * @example
 * ```ts
 * const pending: MusicJobPoll = { state: "pending" };
 * const failed: MusicJobPoll = { state: "failed", error: new Error("generation_timeout") };
 * ```
 */
export type MusicJobPoll =
  | { state: "pending" }
  | ({ state: "done" } & MusicResult)
  | { state: "failed"; error: unknown };

/**
 * The capability contract a music provider plugin implements and registers
 * with the registry under the "music" task. A handler has `estimate` plus
 * either `execute`, or the async pair `submit` + `poll` (or both forms).
 * Owned by this plugin — see spec/15 and `README.md`.
 *
 * @example
 * ```ts
 * const handler: MusicHandler = {
 *   estimate: request => ({ usd: Math.ceil(request.lengthMs / 60_000) * 0.8 }),
 *   submit: async () => ({ jobId: "job-1" }),
 *   poll: async () => ({ state: "pending" })
 * };
 * ```
 */
export type MusicHandler = {
  /**
   * Estimates the cost of `request` without executing it — used by the
   * runner's budget gate and by `app.music.estimate()`.
   *
   * @param request - The request to estimate.
   * @returns The estimated cost in US dollars.
   */
  estimate(request: MusicRequest): { usd: number };
  /**
   * Executes `request` in one call, returning the audio and its actual cost.
   *
   * @param request - The request to execute.
   * @param opts - Execution options.
   * @param opts.signal - Abort signal for cancelling the in-flight request.
   * @returns The generation result.
   */
  execute?(request: MusicRequest, opts: { signal?: AbortSignal }): Promise<MusicResult>;
  /**
   * Submits `request` as a long-running provider job.
   *
   * @param request - The request to submit.
   * @param opts - Submission options.
   * @param opts.signal - Abort signal for cancelling the submission call.
   * @returns The provider job id.
   */
  submit?(request: MusicRequest, opts: { signal?: AbortSignal }): Promise<{ jobId: string }>;
  /**
   * Polls a submitted job once.
   *
   * @param jobId - The id returned by `submit`.
   * @param request - The request the job was submitted with.
   * @param opts - Poll options.
   * @param opts.signal - Abort signal for cancelling the poll call.
   * @returns The job state: pending, done with a result, or failed.
   */
  poll?(
    jobId: string,
    request: MusicRequest,
    opts: { signal?: AbortSignal }
  ): Promise<MusicJobPoll>;
};
