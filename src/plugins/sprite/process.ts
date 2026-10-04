/**
 * @file sprite pixel step — pure, `sharp` only.
 *
 * Trim to the alpha bounds, resize, pad, and encode an RGBA PNG. Sprite
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
  /** Transparent border around the trimmed box, px. With `size`, it sits inside `size`. Default 0. */
  padding?: number;
  /** Output size, px: the output is exactly this, and `padding` sits inside it. Omitted means the size after trim and padding. */
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

/** A target size, px. */
type Size = NonNullable<SpriteProcessOptions["size"]>;

/** A sharp pipeline. */
type Pipeline = ReturnType<typeof sharp>;

/** Raw RGBA pixels with their size. */
type RawImage = { data: Uint8Array; width: number; height: number };

/** Alpha at or below this value counts as empty by default. */
const DEFAULT_ALPHA_THRESHOLD = 8;

/** Bytes per RGBA pixel. */
const CHANNELS = 4;

/** Index of the alpha byte inside one RGBA pixel. */
const ALPHA_OFFSET = CHANNELS - 1;

/** The largest alpha value of an 8-bit channel. */
const MAX_ALPHA = 255;

/** zlib level for the PNG encode: smallest file, lossless. */
const PNG_COMPRESSION_LEVEL = 9;

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
 * Whether `padding` on every side leaves at least 1 px inside `size`.
 *
 * @param size - The output size, padding included.
 * @param padding - Transparent border, px.
 * @returns True when `2 * padding` is less than both `width` and `height`.
 * @example
 * ```ts
 * leavesRoom({ width: 16, height: 16 }, 8); // => false
 * ```
 */
function leavesRoom(size: Size, padding: number): boolean {
  return 2 * padding < size.width && 2 * padding < size.height;
}

/**
 * Whether both sides of `size` are whole pixels of at least 1.
 *
 * @param size - The output size.
 * @returns True when `width` and `height` are integers `>= 1`.
 * @example
 * ```ts
 * hasValidSize({ width: 16, height: 0 }); // => false
 * ```
 */
function hasValidSize(size: Size): boolean {
  return isWholeAtLeast(size.width, 1) && isWholeAtLeast(size.height, 1);
}

/**
 * Whether `padding` is a whole number of pixels of 0 or more.
 *
 * @param padding - Transparent border, px.
 * @returns True for an integer `>= 0`.
 * @example
 * ```ts
 * isValidPadding(-1); // => false
 * ```
 */
function isValidPadding(padding: number): boolean {
  return isWholeAtLeast(padding, 0);
}

/**
 * Whether `threshold` is an alpha value from 0 to {@link MAX_ALPHA}.
 *
 * @param threshold - Alpha at or below this value counts as empty.
 * @returns True for `0 <= threshold <= 255`; false for NaN.
 * @example
 * ```ts
 * isValidAlphaThreshold(256); // => false
 * ```
 */
function isValidAlphaThreshold(threshold: number): boolean {
  return threshold >= 0 && threshold <= MAX_ALPHA;
}

/**
 * Whether `fit` is one of the fits a sprite accepts.
 *
 * @param fit - The requested fit.
 * @returns True for "contain", "cover" or "fill".
 * @example
 * ```ts
 * isKnownFit("stretch"); // => false
 * ```
 */
function isKnownFit(fit: string): boolean {
  return FITS.has(fit);
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

  // Size: both sides whole pixels of at least 1.
  if (size !== undefined && !hasValidSize(size)) {
    throw spriteError(
      `Sprite size must be whole pixels of at least 1, got ${size.width}x${size.height}`,
      "Set size.width and size.height to integers of 1 or more"
    );
  }

  // Padding: whole pixels, never negative.
  if (padding !== undefined && !isValidPadding(padding)) {
    throw spriteError(
      `Sprite padding must be a whole number of pixels of 0 or more, got ${padding}`,
      "Set padding to an integer of 0 or more"
    );
  }

  // Padding inside size: at least 1 px of content must remain.
  if (size !== undefined && padding !== undefined && !leavesRoom(size, padding)) {
    throw spriteError(
      `Sprite padding ${padding} leaves no room inside ${size.width}x${size.height}`,
      "Lower padding or raise size"
    );
  }

  // Alpha threshold: an 8-bit alpha value.
  if (alphaThreshold !== undefined && !isValidAlphaThreshold(alphaThreshold)) {
    throw spriteError(
      `Sprite alphaThreshold must be between 0 and 255, got ${alphaThreshold}`,
      "Set alphaThreshold to a value from 0 to 255"
    );
  }

  // Fit: one of the sharp fits a sprite supports.
  if (fit !== undefined && !isKnownFit(fit)) {
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
      const alpha = raw.data[(y * raw.width + x) * CHANNELS + ALPHA_OFFSET] ?? 0;
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
 * Cuts `box` out of `raw`.
 *
 * @param raw - Raw RGBA pixels.
 * @param box - The box to keep.
 * @returns The cut pixels.
 * @example
 * ```ts
 * await cut(raw, { left: 5, top: 7, width: 10, height: 6 }); // => 10x6 pixels
 * ```
 */
async function cut(raw: RawImage, box: TrimBox): Promise<RawImage> {
  return toRaw(fromRaw(raw).extract(box));
}

/**
 * Resizes `raw` into the box left inside `size` once `padding` is taken from
 * every side, so padding it afterwards gives exactly `size`.
 *
 * @param raw - Raw RGBA pixels.
 * @param size - The final output size, padding included.
 * @param padding - Transparent border, px; `2 * padding` is less than both sides.
 * @param options - The pixel options; `fit` and `pixelArt` are read.
 * @returns The resized pixels, `size - 2 * padding` on each axis.
 * @example
 * ```ts
 * await resizeInside(raw, { width: 16, height: 16 }, 2, { fit: "fill" }); // => 12x12 pixels
 * ```
 */
async function resizeInside(
  raw: RawImage,
  size: Size,
  padding: number,
  options: SpriteProcessOptions
): Promise<RawImage> {
  const pipeline = fromRaw(raw).resize(size.width - 2 * padding, size.height - 2 * padding, {
    fit: options.fit ?? "contain",
    kernel: options.pixelArt === true ? "nearest" : "lanczos3",
    background: TRANSPARENT
  });
  return toRaw(pipeline);
}

/**
 * Wraps `raw` in a pipeline that adds `padding` transparent pixels on every side.
 *
 * @param raw - Raw RGBA pixels.
 * @param padding - Transparent border, px.
 * @returns The sharp pipeline; it outputs `raw` unchanged when `padding` is 0.
 * @example
 * ```ts
 * padded({ data, width: 10, height: 6 }, 3); // => a pipeline that outputs 16x12
 * ```
 */
function padded(raw: RawImage, padding: number): Pipeline {
  const pipeline = fromRaw(raw);
  if (padding === 0) return pipeline;
  return pipeline.extend({
    top: padding,
    bottom: padding,
    left: padding,
    right: padding,
    background: TRANSPARENT
  });
}

/**
 * Trims a transparent image to its alpha bounds, resizes it, pads it, and
 * encodes it as an RGBA PNG (`compressionLevel: 9`). With a `size`, the image
 * is resized to `size - 2 * padding` and then padded, so the output is exactly
 * `size` and the border is exactly `padding` px. Without a `size`, it is
 * trimmed and padded. A sprite provider calls it after its background-removal
 * step (the `none` model calls it on the source as-is).
 *
 * @param png - The image bytes, any format sharp reads; an alpha channel is added when missing.
 * @param options - The pixel options; a whole `SpriteRequest` fits.
 * @returns The PNG, its output size, and the box kept from the source.
 * @throws {Error} For an invalid `size`, `padding`, `alphaThreshold` or `fit`, before any work.
 * @throws {Error} `[ai] Sprite padding <p> leaves no room inside <w>x<h>.` when `2 * padding` is not less than both sides of `size`.
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

  // Trim, then resize into the box inside the padding when a size is set.
  const trimBox =
    options.trim === false
      ? { left: 0, top: 0, width: source.width, height: source.height }
      : bounds;
  const padding = options.padding ?? 0;
  const trimmed = await cut(source, trimBox);
  const content =
    options.size === undefined
      ? trimmed
      : await resizeInside(trimmed, options.size, padding, options);

  // Pad last, so the border is exactly `padding` px, then encode.
  const { data, info } = await padded(content, padding)
    .png({ compressionLevel: PNG_COMPRESSION_LEVEL })
    .toBuffer({ resolveWithObject: true });

  const image = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return { image, width: info.width, height: info.height, trimBox };
}
