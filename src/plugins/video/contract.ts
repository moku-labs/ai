/**
 * @file video capability contract — task-owned; providers implement this.
 *
 * Self-contained by design (spec/07 — "small structural duplication across
 * task contracts is the ratified price of true task ownership"): no shared
 * base type is imported from elsewhere, so this file alone defines what a
 * "video provider" is. Provider plugins type-import these via
 * `import type { VideoHandler } from "../video/contract"`.
 */

/**
 * A resolved input file handed to a video provider: a path in the content
 * store plus its MIME type and content hash.
 *
 * @example
 * ```ts
 * const frame: VideoFile = { path: ".moku/store/ab/abcd", mimeType: "image/png", hash: "abcd" };
 * ```
 */
export type VideoFile = {
  /** Absolute or project-relative path to the file bytes. */
  path: string;
  /** MIME type of the file (e.g. "image/png"). */
  mimeType: string;
  /** Content hash of the file bytes. */
  hash: string;
};

/**
 * A single video generation request: model, prompt, optional keyframe and
 * references, plus clip shape hints and pass-through provider params.
 *
 * @example
 * ```ts
 * const request: VideoRequest = { model: "minimax-h3", prompt: "slow push-in", seconds: 5 };
 * ```
 */
export type VideoRequest = {
  /** Provider-scoped model id or alias, e.g. "minimax-h3". Required: price and endpoint depend on it. */
  model: string;
  /** Motion and scene prompt. */
  prompt: string;
  /** Things to avoid (ignored by models without a negative prompt). */
  negative?: string;
  /** First frame / keyframe. */
  image?: VideoFile;
  /** Extra reference images. */
  refs?: VideoFile[];
  /** Clip length in seconds. Default 5. */
  seconds?: number;
  /** Aspect ratio. Default "9:16". */
  aspect?: string;
  /** Model-specific resolution, e.g. "720p", "768P". */
  resolution?: string;
  /** Generate native audio when the model can. Default false. */
  audio?: boolean;
  /** Pass-through provider params, merged last into the provider body. */
  params?: Record<string, unknown>;
};

/**
 * The result of one video generation: raw clip bytes plus enough metadata
 * to journal cost and identity without re-deriving them.
 *
 * @example
 * ```ts
 * const result: VideoResult = { video: new Uint8Array(), mimeType: "video/mp4", costUsd: 0.27 };
 * ```
 */
export type VideoResult = {
  /** The generated video bytes. */
  video: Uint8Array;
  /** MIME type of `video` (e.g. "video/mp4"). */
  mimeType: string;
  /** Actual cost of this generation, in US dollars. */
  costUsd: number;
  /** Metadata only, never a payload echo (e.g. durationMs, model, requestId). */
  meta?: Record<string, unknown>;
};

/**
 * One poll of an async video job: still running, finished with a result,
 * or failed with the provider's error.
 *
 * @example
 * ```ts
 * const pending: VideoJobPoll = { state: "pending" };
 * const failed: VideoJobPoll = { state: "failed", error: new Error("content policy") };
 * ```
 */
export type VideoJobPoll =
  | { state: "pending" }
  | ({ state: "done" } & VideoResult)
  | { state: "failed"; error: unknown };

/**
 * The capability contract a video provider plugin implements and registers
 * with the registry under the "video" task. A handler has `estimate` plus
 * either `execute`, or the async pair `submit` + `poll` (or both forms).
 * Owned by this plugin — see spec/15 and `README.md`.
 *
 * @example
 * ```ts
 * const handler: VideoHandler = {
 *   estimate: request => ({ usd: (request.seconds ?? 5) * 0.05 }),
 *   submit: async () => ({ jobId: "job-1" }),
 *   poll: async () => ({ state: "pending" })
 * };
 * ```
 */
export type VideoHandler = {
  /**
   * Estimates the cost of `request` without executing it — used by the
   * runner's budget gate and by `app.video.estimate()`.
   *
   * @param request - The request to estimate.
   * @returns The estimated cost in US dollars.
   * @example
   * ```ts
   * handler.estimate({ model: "minimax-h3", prompt: "push-in" }); // => { usd: 0.25 }
   * ```
   */
  estimate(request: VideoRequest): { usd: number };
  /**
   * Executes `request` in one call, returning the clip and its actual cost.
   *
   * @param request - The request to execute.
   * @param opts - Execution options.
   * @param opts.signal - Abort signal for cancelling the in-flight request.
   * @returns The generation result.
   * @example
   * ```ts
   * await handler.execute?.({ model: "minimax-h3", prompt: "push-in" }, {});
   * ```
   */
  execute?(request: VideoRequest, opts: { signal?: AbortSignal }): Promise<VideoResult>;
  /**
   * Submits `request` as a long-running provider job.
   *
   * @param request - The request to submit.
   * @param opts - Submission options.
   * @param opts.signal - Abort signal for cancelling the submission call.
   * @returns The provider job id.
   * @example
   * ```ts
   * const { jobId } = await handler.submit!({ model: "minimax-h3", prompt: "push-in" }, {});
   * ```
   */
  submit?(request: VideoRequest, opts: { signal?: AbortSignal }): Promise<{ jobId: string }>;
  /**
   * Polls a submitted job once.
   *
   * @param jobId - The id returned by `submit`.
   * @param request - The request the job was submitted with.
   * @param opts - Poll options.
   * @param opts.signal - Abort signal for cancelling the poll call.
   * @returns The job state: pending, done with a result, or failed.
   * @example
   * ```ts
   * const status = await handler.poll!("job-1", request, {});
   * ```
   */
  poll?(
    jobId: string,
    request: VideoRequest,
    opts: { signal?: AbortSignal }
  ): Promise<VideoJobPoll>;
};
