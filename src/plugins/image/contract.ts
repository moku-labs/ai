/**
 * @file image capability contract — task-owned; providers implement this.
 *
 * Self-contained by design (spec/07 — "small structural duplication across
 * task contracts is the ratified price of true task ownership"): no shared
 * base type is imported from elsewhere, so this file alone defines what an
 * "image provider" is. Provider plugins type-import these via
 * `import type { ImageHandler } from "../image/contract"`.
 */

/**
 * A resolved local file: what the runner hands a handler for `$ref` /
 * `$file` inputs (a character sheet, a location plate, an earlier keyframe).
 *
 * @example
 * ```ts
 * const file: ImageFile = { path: "out/hero.png", mimeType: "image/png", hash: "sha256:ab12" };
 * ```
 */
export type ImageFile = {
  /** Absolute or project-relative path of the file on disk. */
  path: string;
  /** MIME type of the file (e.g. "image/png"). */
  mimeType: string;
  /** Content hash, so artifact identity follows the bytes, not the path. */
  hash: string;
};

/**
 * A single still-image generation request: what to draw, what to avoid,
 * and optional model/aspect/reference/param hints.
 *
 * @example
 * ```ts
 * const request: ImageRequest = { prompt: "a patisserie at night", aspect: "9:16" };
 * ```
 */
export type ImageRequest = {
  /** What to draw. The caller already appended the series style. */
  prompt: string;
  /** Things to avoid. */
  negative?: string;
  /** Provider-scoped model id. */
  model?: string;
  /** Aspect ratio, e.g. "9:16". Providers default to "9:16" when omitted. */
  aspect?: string;
  /** Reference images (character sheet, location plate, earlier keyframe). */
  refs?: ImageFile[];
  /** Pass-through provider params. */
  params?: Record<string, unknown>;
};

/**
 * The result of one image generation: raw image bytes plus enough metadata
 * to journal cost and identity without ever re-deriving them.
 *
 * @example
 * ```ts
 * const result: ImageResult = { image: new Uint8Array(), mimeType: "image/png", costUsd: 0.04 };
 * ```
 */
export type ImageResult = {
  /** The generated image bytes. */
  image: Uint8Array;
  /** MIME type of `image` (e.g. "image/png", "image/webp"). */
  mimeType: string;
  /** Actual cost of this generation, in US dollars. */
  costUsd: number;
  /** Metadata only, never a payload echo (e.g. model, seed, width, height). */
  meta?: Record<string, unknown>;
};

/**
 * The capability contract an image provider plugin implements and registers
 * with the registry under the "image" task. Owned by this plugin — see
 * spec/14 and `README.md`.
 *
 * @example
 * ```ts
 * const handler: ImageHandler = {
 *   estimate: () => ({ usd: 0.04 }),
 *   execute: async () => ({ image: new Uint8Array(), mimeType: "image/png", costUsd: 0.04 })
 * };
 * ```
 */
export type ImageHandler = {
  /**
   * Estimates the cost of `request` without executing it — used by the
   * runner's budget gate and by `app.image.estimate()`.
   *
   * @param request - The request to estimate.
   * @returns The estimated cost in US dollars.
   * @example
   * ```ts
   * handler.estimate({ prompt: "a cat" }); // => { usd: 0.04 }
   * ```
   */
  estimate(request: ImageRequest): { usd: number };
  /**
   * Executes `request`, returning the generated image and its actual cost.
   *
   * @param request - The request to execute.
   * @param opts - Execution options.
   * @param opts.signal - Abort signal for cancelling the in-flight request.
   * @returns The generation result.
   * @example
   * ```ts
   * await handler.execute({ prompt: "a cat" }, {});
   * ```
   */
  execute(request: ImageRequest, opts: { signal?: AbortSignal }): Promise<ImageResult>;
};
