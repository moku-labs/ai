/**
 * @file sprite capability contract — task-owned; providers implement this.
 *
 * Self-contained by design (spec/03 §3, spec/07 — "small structural
 * duplication across task contracts is the ratified price of true task
 * ownership"): it imports no plugin module, so this file alone defines what a
 * "sprite provider" is. Provider plugins type-import it via
 * `import type { SpriteHandler } from "../sprite/contract"` without a `depends` edge.
 */

/**
 * A stored file handed to a sprite provider. The runner resolves `{ $ref: id }`
 * and `{ $file: path }` in a build item into this shape.
 *
 * @example
 * ```ts
 * const file: SpriteFile = { path: "/repo/.moku/store/ab/abcd", mimeType: "image/png", hash: "abcd" };
 * ```
 */
export type SpriteFile = {
  /** Absolute path of the file on disk. */
  path: string;
  /** MIME type of the file, e.g. "image/png". */
  mimeType: string;
  /** Content hash of the file. */
  hash: string;
};

/**
 * A single sprite request: cut an existing image into a transparent PNG.
 * `model` is required: the runner hashes the input as written, so a model
 * defaulted inside the provider would not be part of the artifact key.
 *
 * @example
 * ```ts
 * const request: SpriteRequest = { source: file, model: "birefnet", size: { width: 128, height: 64 }, padding: 2 };
 * ```
 */
export type SpriteRequest = {
  /** The source image: the runner resolves `{ $ref: id }` / `{ $file: path }` into this. */
  source: SpriteFile;
  /** Matte model alias, e.g. "birefnet". "none" means the source is already transparent. Required (artifact key). */
  model: string;
  /** Trim to the alpha bounding box. Default true. */
  trim?: boolean;
  /** Transparent border around the trimmed box, px. With `size`, it sits inside `size`. Default 0. */
  padding?: number;
  /** Target size. Omitted means the size after trim. */
  size?: { width: number; height: number };
  /** How the trimmed image fits `size`. Default "contain" (transparent letterbox). */
  fit?: "contain" | "cover" | "fill";
  /** Nearest-neighbour resize for pixel art. Default false (lanczos3). */
  pixelArt?: boolean;
  /** Alpha at or below this value counts as empty when trimming, 0..255. Default 8. */
  alphaThreshold?: number;
  /** Provider params; each provider documents which keys it reads. */
  params?: Record<string, unknown>;
};

/**
 * The result of one sprite cut: PNG bytes plus enough metadata to journal
 * cost and identity without re-deriving them.
 *
 * @example
 * ```ts
 * const result: SpriteResult = { image: new Uint8Array(), mimeType: "image/png", costUsd: 0.002 };
 * ```
 */
export type SpriteResult = {
  /** The transparent PNG bytes (RGBA). */
  image: Uint8Array;
  /** Always "image/png". */
  mimeType: "image/png";
  /** Actual cost of this cut, in US dollars. */
  costUsd: number;
  /** width, height, trimBox {left, top, width, height}, model. Metadata only, never a payload echo. */
  meta?: Record<string, unknown>;
};

/**
 * The capability contract a sprite provider plugin implements and registers
 * with the registry under the "sprite" task. A handler has `estimate` and
 * `execute`; there is no submit/poll form. Owned by this plugin — see spec/15
 * and `README.md`.
 *
 * @example
 * ```ts
 * const handler: SpriteHandler = {
 *   estimate: request => ({ usd: request.model === "none" ? 0 : 0.002 }),
 *   execute: async request => {
 *     const cut = await processSprite(await readFile(request.source.path), request);
 *     return { image: cut.image, mimeType: "image/png", costUsd: 0 };
 *   }
 * };
 * ```
 */
export type SpriteHandler = {
  /**
   * Estimates the cost of `request` without executing it — used by the
   * runner's budget gate and by `app.sprite.estimate()`. Reads `model` only:
   * the runner estimates the request before `source` is resolved.
   *
   * @param request - The request to estimate.
   * @returns The estimated cost in US dollars.
   */
  estimate(request: SpriteRequest): { usd: number };
  /**
   * Executes `request` in one call, returning the PNG and its actual cost.
   *
   * @param request - The request to execute.
   * @param opts - Execution options.
   * @param opts.signal - Abort signal for cancelling the in-flight request.
   * @returns The sprite result.
   */
  execute(request: SpriteRequest, opts: { signal?: AbortSignal }): Promise<SpriteResult>;
};
