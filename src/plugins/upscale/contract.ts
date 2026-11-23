/**
 * @file upscale capability contract — task-owned; providers implement this.
 *
 * Self-contained by design (spec/03 §3, spec/07 — "small structural
 * duplication across task contracts is the ratified price of true task
 * ownership"): it imports no plugin module, so this file alone defines what an
 * "upscale provider" is. Provider plugins type-import it via
 * `import type { UpscaleHandler } from "../upscale/contract"` without a `depends` edge.
 */

/**
 * A resolved input file: the runner turns a build file's `$ref` / `$file` into this.
 *
 * @example
 * ```ts
 * const file: UpscaleFile = { path: "out/ep01.mp4", mimeType: "video/mp4", hash: "ab12" };
 * ```
 */
export type UpscaleFile = {
  /** Absolute or project-relative path of the file on disk. */
  path: string;
  /** MIME type of the file, e.g. "video/mp4". */
  mimeType: string;
  /** Content hash of the file; providers dedupe uploads by it. */
  hash: string;
};

/**
 * One upscale request. `model` is required: the runner hashes the input as
 * written, so a model defaulted inside the provider would not be part of the
 * artifact key and a changed default would reuse another model's video.
 *
 * @example
 * ```ts
 * const request: UpscaleRequest = {
 *   video: { path: "out/ep01.mp4", mimeType: "video/mp4", hash: "ab12" },
 *   model: "starlight-fast-2",
 *   factor: 1.5,
 *   seconds: 62.4
 * };
 * ```
 */
export type UpscaleRequest = {
  /** The source video. */
  video: UpscaleFile;
  /** Provider-scoped model alias, e.g. "starlight-fast-2". Required: price, endpoint and output depend on it. */
  model: string;
  /** Upscale factor, 1–4 (1.5 turns 720×1280 into 1080×1920). */
  factor: number;
  /** Source length in seconds; drives the estimate and `costUsd`. */
  seconds: number;
  /** Provider params; each provider documents which keys it reads. */
  params?: Record<string, unknown>;
};

/**
 * The source video at estimate time: a resolved file, or still the build-file
 * reference the runner resolves before submit (the runner estimates the
 * unresolved request).
 *
 * @example
 * ```ts
 * const input: UpscaleEstimateInput = { $ref: "clean" };
 * ```
 */
export type UpscaleEstimateInput = UpscaleFile | { $ref: string } | { $file: string };

/**
 * An upscale request at estimate time: its `video` may still be a build-file
 * reference. Every `UpscaleRequest` is one.
 *
 * @example
 * ```ts
 * const request: UpscaleEstimateRequest = {
 *   video: { $file: "out/ep01.mp4" },
 *   model: "proteus",
 *   factor: 1.5,
 *   seconds: 10
 * };
 * ```
 */
export type UpscaleEstimateRequest = Omit<UpscaleRequest, "video"> & {
  /** The source video, resolved or not. */
  video: UpscaleEstimateInput;
};

/**
 * The result of one upscale: raw video bytes plus enough metadata to journal
 * cost and identity without re-deriving them.
 *
 * @example
 * ```ts
 * const result: UpscaleResult = { video: new Uint8Array(), mimeType: "video/mp4", costUsd: 3.744 };
 * ```
 */
export type UpscaleResult = {
  /** The upscaled video bytes. */
  video: Uint8Array;
  /** MIME type of `video`, e.g. "video/mp4". */
  mimeType: string;
  /** Actual cost of this upscale, in US dollars. */
  costUsd: number;
  /** Metadata only, never a payload echo (e.g. model, endpoint, requestId, seconds, factor). */
  meta?: Record<string, unknown>;
};

/**
 * One poll of an async upscale job: still running, finished with a result,
 * or failed with the provider's error.
 *
 * @example
 * ```ts
 * const pending: UpscaleJobPoll = { state: "pending" };
 * const failed: UpscaleJobPoll = { state: "failed", error: new Error("job_timeout") };
 * ```
 */
export type UpscaleJobPoll =
  | { state: "pending" }
  | ({ state: "done" } & UpscaleResult)
  | { state: "failed"; error: unknown };

/**
 * The capability contract an upscale provider plugin implements and registers
 * with the registry under the "upscale" task. A handler has `estimate` plus
 * either `execute`, or the async pair `submit` + `poll` (or both forms).
 * Owned by this plugin — see spec/15 and `README.md`.
 *
 * @example
 * ```ts
 * const handler: UpscaleHandler = {
 *   estimate: request => ({ usd: request.seconds * 0.06 }),
 *   submit: async () => ({ jobId: "job-1" }),
 *   poll: async () => ({ state: "pending" })
 * };
 * ```
 */
export type UpscaleHandler = {
  /**
   * Estimates the cost of `request` without executing it — used by the
   * runner's budget gate and by `app.upscale.estimate()`. At plan time `video`
   * may still be a `$ref` / `$file` reference.
   *
   * @param request - The request to estimate.
   * @returns The estimated cost in US dollars.
   */
  estimate(request: UpscaleEstimateRequest): { usd: number };
  /**
   * Executes `request` in one call, returning the video and its actual cost.
   *
   * @param request - The request to execute.
   * @param opts - Execution options.
   * @param opts.signal - Abort signal for cancelling the in-flight request.
   * @returns The upscale result.
   */
  execute?(request: UpscaleRequest, opts: { signal?: AbortSignal }): Promise<UpscaleResult>;
  /**
   * Submits `request` as a long-running provider job.
   *
   * @param request - The request to submit.
   * @param opts - Submission options.
   * @param opts.signal - Abort signal for cancelling the submission call.
   * @returns The provider job id.
   */
  submit?(request: UpscaleRequest, opts: { signal?: AbortSignal }): Promise<{ jobId: string }>;
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
    request: UpscaleRequest,
    opts: { signal?: AbortSignal }
  ): Promise<UpscaleJobPoll>;
};
