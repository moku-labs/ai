/**
 * @file sprite pixel step — pure, `sharp` only.
 *
 * Trim to the alpha bounds, pad, resize, and encode an RGBA PNG. Sprite
 * providers import this module at runtime after their background-removal call
 * (decision D6): it is a function module, not a plugin, so it adds no
 * `depends` edge. It imports nothing from other plugins, and declares its own
 * structural option types so it does not depend on the contract file either.
 */
import sharp from "sharp";

/**
 * A rectangle in pixels: the part of the source image a sprite keeps.
 *
 * @example
 * ```ts
 * const box: TrimBox = { left: 5, top: 7, width: 10, height: 6 };
 * ```
 */
export type TrimBox = { left: number; top: number; width: number; height: number };

/**
 * The pixel options of a sprite request. Structurally the same as
 * `Pick<SpriteRequest, "trim" | "padding" | "size" | "fit" | "pixelArt" | "alphaThreshold">`,
 * so a provider passes its whole request.
 *
 * @example
 * ```ts
 * const options: SpriteProcessOptions = { padding: 2, size: { width: 128, height: 64 }, fit: "contain" };
 * ```
 */
export type SpriteProcessOptions = {
  /** Trim to the alpha bounding box. Default true. */
  trim?: boolean;
  /** Transparent padding kept around the trimmed box, px. Default 0. */
  padding?: number;
  /** Target size. Omitted means the size after trim and padding. */
  size?: { width: number; height: number };
  /** How the image fits `size`. Default "contain" (transparent letterbox). */
  fit?: "contain" | "cover" | "fill";
  /** Nearest-neighbour resize for pixel art. Default false (lanczos3). */
  pixelArt?: boolean;
  /** Alpha at or below this value counts as empty, 0..255. Default 8. */
  alphaThreshold?: number;
};

/**
 * The output of {@link processSprite}: the PNG and its geometry.
 *
 * @example
 * ```ts
 * const cut: ProcessedSprite = { image: png, width: 10, height: 6, trimBox: { left: 5, top: 7, width: 10, height: 6 } };
 * ```
 */
export type ProcessedSprite = {
  /** The RGBA PNG bytes. */
  image: Uint8Array;
  /** Output width, px. */
  width: number;
  /** Output height, px. */
  height: number;
  /** The box kept from the source; the whole image when `trim` is false. */
  trimBox: TrimBox;
};

/** A sharp pipeline. */
type Pipeline = ReturnType<typeof sharp>;

/** Raw RGBA pixels with their size. */
type RawImage = { data: Uint8Array; width: number; height: number };

/** Alpha at or below this value counts as empty by default. */
const DEFAULT_ALPHA_THRESHOLD = 8;

/** Bytes per RGBA pixel. */
const CHANNELS = 4;

/** Fully transparent black: the letterbox and padding colour. */
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

/** The fits a sprite accepts. */
const FITS: ReadonlySet<string> = new Set(["contain", "cover", "fill"]);

/**
 * Builds a two-line `[ai]` error.
 *
 * @param description - What is wrong, without the final period.
 * @param suggestion - What to do, without the final period.
 * @returns The error.
 * @example
 * ```ts
 * spriteError("Sprite padding is bad", "Fix it").message; // => "[ai] Sprite padding is bad.\n  Fix it."
 * ```
 */
function spriteError(description: string, suggestion: string): Error {
  return new Error(`[ai] ${description}.\n  ${suggestion}.`);
}

/**
 * Whether `value` is a whole number of at least `minimum`.
 *
 * @param value - The number to check.
 * @param minimum - The smallest allowed value.
 * @returns True for an integer `>= minimum`.
 * @example
 * ```ts
 * isWholeAtLeast(1.5, 1); // => false
 * ```
 */
function isWholeAtLeast(value: number, minimum: number): boolean {
  return Number.isInteger(value) && value >= minimum;
}

/**
 * Throws for an invalid size, padding, alpha threshold or fit, before any pixel work.
 *
 * @param options - The pixel options.
 * @throws {Error} A two-line `[ai]` error naming the field and the value.
 * @example
 * ```ts
 * assertOptions({ padding: -1 }); // throws "[ai] Sprite padding must be ... got -1. ..."
 * ```
 */
function assertOptions(options: SpriteProcessOptions): void {
  const { size, padding, alphaThreshold, fit } = options;

  if (size !== undefined && !(isWholeAtLeast(size.width, 1) && isWholeAtLeast(size.height, 1))) {
    throw spriteError(
      `Sprite size must be whole pixels of at least 1, got ${size.width}x${size.height}`,
      "Set size.width and size.height to integers of 1 or more"
    );
  }
  if (padding !== undefined && !isWholeAtLeast(padding, 0)) {
    throw spriteError(
      `Sprite padding must be a whole number of pixels of 0 or more, got ${padding}`,
      "Set padding to an integer of 0 or more"
    );
  }
  if (alphaThreshold !== undefined && !(alphaThreshold >= 0 && alphaThreshold <= 255)) {
    throw spriteError(
      `Sprite alphaThreshold must be between 0 and 255, got ${alphaThreshold}`,
      "Set alphaThreshold to a value from 0 to 255"
    );
  }
  if (fit !== undefined && !FITS.has(fit)) {
    throw spriteError(
      `Sprite fit must be "contain", "cover" or "fill", got "${String(fit)}"`,
      "Set fit to one of those values"
    );
  }
}

/**
 * The bounding box of the pixels whose alpha is above `threshold`, found by
 * scanning the raw RGBA buffer.
 *
 * @param raw - Raw RGBA pixels.
 * @param threshold - Alpha at or below this value counts as empty.
 * @returns The box, or undefined when no pixel is above the threshold.
 * @example
 * ```ts
 * alphaBounds({ data: new Uint8Array([0, 0, 0, 0, 9, 9, 9, 255]), width: 2, height: 1 }, 8); // => { left: 1, top: 0, width: 1, height: 1 }
 * ```
 */
function alphaBounds(raw: RawImage, threshold: number): TrimBox | undefined {
  let left = raw.width;
  let top = raw.height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < raw.height; y += 1) {
    for (let x = 0; x < raw.width; x += 1) {
      const alpha = raw.data[(y * raw.width + x) * CHANNELS + 3] ?? 0;
      if (alpha <= threshold) continue;

      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }

  if (right < 0) return undefined;
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * Wraps raw RGBA pixels in a sharp pipeline.
 *
 * @param raw - Raw RGBA pixels.
 * @returns The sharp instance.
 * @example
 * ```ts
 * fromRaw({ data: new Uint8Array(4), width: 1, height: 1 }); // => a 1x1 sharp pipeline
 * ```
 */
function fromRaw(raw: RawImage): Pipeline {
  return sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: CHANNELS } });
}

/**
 * Runs `pipeline` to raw RGBA pixels.
 *
 * @param pipeline - A sharp pipeline whose output has an alpha channel.
 * @returns The raw pixels and their size.
 * @example
 * ```ts
 * await toRaw(sharp(png).ensureAlpha()); // => { data, width: 32, height: 32 }
 * ```
 */
async function toRaw(pipeline: Pipeline): Promise<RawImage> {
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Cuts `box` out of `raw` and adds `padding` transparent pixels on every side.
 *
 * @param raw - Raw RGBA pixels.
 * @param box - The box to keep.
 * @param padding - Transparent border, px.
 * @returns The cut, padded pixels.
 * @example
 * ```ts
 * await cutAndPad(raw, { left: 5, top: 7, width: 10, height: 6 }, 3); // => 16x12 pixels
 * ```
 */
async function cutAndPad(raw: RawImage, box: TrimBox, padding: number): Promise<RawImage> {
  const pipeline = fromRaw(raw).extract(box);
  if (padding > 0) {
    pipeline.extend({
      top: padding,
      bottom: padding,
      left: padding,
      right: padding,
      background: TRANSPARENT
    });
  }
  return toRaw(pipeline);
}

/**
 * Trims a transparent image to its alpha bounds, pads it, resizes it, and
 * encodes it as an RGBA PNG (`compressionLevel: 9`). Steps run in that order,
 * so a `size` is the exact output size, padding included. A sprite provider
 * calls it after its background-removal step (the `none` model calls it on the
 * source as-is).
 *
 * @param png - The image bytes, any format sharp reads; an alpha channel is added when missing.
 * @param options - The pixel options; a whole `SpriteRequest` fits.
 * @returns The PNG, its output size, and the box kept from the source.
 * @throws {Error} For an invalid `size`, `padding`, `alphaThreshold` or `fit`, before any work.
 * @throws {Error} `[ai] Sprite is empty after background removal.` when no pixel is above `alphaThreshold`.
 * @example
 * ```ts
 * // A matte model returned a 32x32 picture with a 10x6 button at (5,7).
 * const cut = await processSprite(mattePng, { padding: 1 });
 * // cut.width === 12, cut.height === 8, cut.trimBox => { left: 5, top: 7, width: 10, height: 6 }
 * ```
 */
export async function processSprite(
  png: Uint8Array,
  options: SpriteProcessOptions
): Promise<ProcessedSprite> {
  assertOptions(options);

  // Decode to raw RGBA and find what is not empty.
  const source = await toRaw(sharp(png).ensureAlpha());
  const bounds = alphaBounds(source, options.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD);
  if (bounds === undefined) {
    throw spriteError(
      "Sprite is empty after background removal",
      "Check the source image or lower alphaThreshold"
    );
  }

  // Trim, then pad, so a later resize lands on the exact target size.
  const trimBox =
    options.trim === false
      ? { left: 0, top: 0, width: source.width, height: source.height }
      : bounds;
  const cut = await cutAndPad(source, trimBox, options.padding ?? 0);

  // Resize when asked, then encode.
  const pipeline = fromRaw(cut);
  if (options.size !== undefined) {
    pipeline.resize(options.size.width, options.size.height, {
      fit: options.fit ?? "contain",
      kernel: options.pixelArt === true ? "nearest" : "lanczos3",
      background: TRANSPARENT
    });
  }
  const { data, info } = await pipeline
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });

  const image = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return { image, width: info.width, height: info.height, trimBox };
}
