/**
 * @file Image dimensions from file headers — PNG (IHDR), JPEG (SOF marker)
 * and WebP (VP8, VP8L, VP8X). Pure byte parsing, no dependency. Used by the
 * price table: fal bills MiniMax H3 Max reference images by aspect ratio.
 */

/**
 * Pixel dimensions of an image.
 *
 * @example
 * ```ts
 * const size: ImageSize = { width: 1024, height: 576 };
 * ```
 */
export type ImageSize = {
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
  height: number;
};

/** PNG file signature. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** JPEG markers without a length field (SOI, TEM, RST0-RST7). */
const STANDALONE_JPEG_MARKERS: ReadonlySet<number> = new Set([
  0xd8, 0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7
]);

/** C0-CF markers that are not a start-of-frame (DHT, JPG, DAC). */
const NON_SOF_MARKERS: ReadonlySet<number> = new Set([0xc4, 0xc8, 0xcc]);

/**
 * Reads the ASCII text of `length` bytes at `offset`.
 *
 * @param bytes - File bytes.
 * @param offset - Start offset.
 * @param length - Byte count.
 * @returns The text.
 * @example
 * ```ts
 * ascii(bytes, 8, 4); // => "WEBP"
 * ```
 */
function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCodePoint(...bytes.subarray(offset, offset + length));
}

/**
 * Reads a byte, treating out-of-range offsets as 0.
 *
 * @param bytes - File bytes.
 * @param offset - Offset.
 * @returns The byte value.
 * @example
 * ```ts
 * byteAt(bytes, 0); // => 0x89
 * ```
 */
function byteAt(bytes: Uint8Array, offset: number): number {
  return bytes[offset] ?? 0;
}

/**
 * Reads a big-endian 16-bit integer.
 *
 * @param bytes - File bytes.
 * @param offset - Offset.
 * @returns The value.
 * @example
 * ```ts
 * uint16BE(bytes, 2); // => 16
 * ```
 */
function uint16BE(bytes: Uint8Array, offset: number): number {
  return (byteAt(bytes, offset) << 8) | byteAt(bytes, offset + 1);
}

/**
 * Reads a little-endian 16-bit integer.
 *
 * @param bytes - File bytes.
 * @param offset - Offset.
 * @returns The value.
 * @example
 * ```ts
 * uint16LE(bytes, 26); // => 1024
 * ```
 */
function uint16LE(bytes: Uint8Array, offset: number): number {
  return byteAt(bytes, offset) | (byteAt(bytes, offset + 1) << 8);
}

/**
 * Reads a little-endian 24-bit integer.
 *
 * @param bytes - File bytes.
 * @param offset - Offset.
 * @returns The value.
 * @example
 * ```ts
 * uint24LE(bytes, 24); // => 1023
 * ```
 */
function uint24LE(bytes: Uint8Array, offset: number): number {
  return uint16LE(bytes, offset) | (byteAt(bytes, offset + 2) << 16);
}

/**
 * Reads a big-endian 32-bit integer.
 *
 * @param bytes - File bytes.
 * @param offset - Offset.
 * @returns The value.
 * @example
 * ```ts
 * uint32BE(bytes, 16); // => 1024
 * ```
 */
function uint32BE(bytes: Uint8Array, offset: number): number {
  return uint16BE(bytes, offset) * 0x1_00_00 + uint16BE(bytes, offset + 2);
}

/**
 * Keeps a size only when both sides are positive.
 *
 * @param width - Width in pixels.
 * @param height - Height in pixels.
 * @returns The size, or undefined.
 * @example
 * ```ts
 * positiveSize(0, 10); // => undefined
 * ```
 */
function positiveSize(width: number, height: number): ImageSize | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * PNG size from the IHDR chunk.
 *
 * @param bytes - File bytes.
 * @returns The size, or undefined when this is not a PNG.
 * @example
 * ```ts
 * pngSize(bytes); // => { width: 1024, height: 1024 }
 * ```
 */
function pngSize(bytes: Uint8Array): ImageSize | undefined {
  const isPng = PNG_SIGNATURE.every((value, index) => bytes[index] === value);
  if (!isPng || ascii(bytes, 12, 4) !== "IHDR") return undefined;
  return positiveSize(uint32BE(bytes, 16), uint32BE(bytes, 20));
}

/**
 * JPEG size from the first start-of-frame marker, skipping every segment
 * before it (APP0/APP1 EXIF, DQT, DHT, ...).
 *
 * @param bytes - File bytes.
 * @returns The size, or undefined when this is not a JPEG or has no SOF.
 * @example
 * ```ts
 * jpegSize(bytes); // => { width: 1920, height: 1080 }
 * ```
 */
function jpegSize(bytes: Uint8Array): ImageSize | undefined {
  if (byteAt(bytes, 0) !== 0xff || byteAt(bytes, 1) !== 0xd8) return undefined;

  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (byteAt(bytes, offset) !== 0xff) return undefined;
    const marker = byteAt(bytes, offset + 1);
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (STANDALONE_JPEG_MARKERS.has(marker)) {
      offset += 2;
      continue;
    }

    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && !NON_SOF_MARKERS.has(marker);
    if (isStartOfFrame) {
      return positiveSize(uint16BE(bytes, offset + 7), uint16BE(bytes, offset + 5));
    }
    offset += 2 + uint16BE(bytes, offset + 2);
  }
  return undefined;
}

/**
 * WebP size from its first chunk: lossy (`VP8 `), lossless (`VP8L`) or
 * extended (`VP8X`).
 *
 * @param bytes - File bytes.
 * @returns The size, or undefined when this is not a WebP.
 * @example
 * ```ts
 * webpSize(bytes); // => { width: 1024, height: 576 }
 * ```
 */
function webpSize(bytes: Uint8Array): ImageSize | undefined {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return undefined;

  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8 ") {
    return positiveSize(uint16LE(bytes, 26) & 0x3f_ff, uint16LE(bytes, 28) & 0x3f_ff);
  }
  if (chunk === "VP8L") {
    const b0 = byteAt(bytes, 21);
    const b1 = byteAt(bytes, 22);
    const b2 = byteAt(bytes, 23);
    const b3 = byteAt(bytes, 24);
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return positiveSize(width, height);
  }
  if (chunk === "VP8X") {
    return positiveSize(1 + uint24LE(bytes, 24), 1 + uint24LE(bytes, 27));
  }
  return undefined;
}

/**
 * Reads an image's pixel dimensions from its header.
 *
 * @param bytes - File bytes (the whole file, or at least its header).
 * @returns The size, or undefined for another format or a damaged header.
 * @example
 * ```ts
 * imageSize(await readFile("face.png")); // => { width: 1024, height: 1024 }
 * ```
 */
export function imageSize(bytes: Uint8Array): ImageSize | undefined {
  return pngSize(bytes) ?? jpegSize(bytes) ?? webpSize(bytes);
}
