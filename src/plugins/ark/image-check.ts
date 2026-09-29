/**
 * @file ark local asset image checks — the limits Ark CreateAsset documents
 * (PNG, JPEG or WebP; under 30 MB; each side 300–6000 px; width/height ratio
 * 0.4–2.5), checked before any call. Width and height come from the file
 * header: a local copy of the PNG (IHDR), JPEG (SOF marker) and WebP (VP8,
 * VP8L, VP8X) probe, pure byte parsing with no dependency and no import from
 * another provider plugin.
 */
import { readFile } from "node:fs/promises";
import type { AssetFile } from "../asset/contract";

/**
 * Pixel dimensions of an image.
 *
 * @example
 * ```ts
 * const size: ImageSize = { width: 1024, height: 1024 };
 * ```
 */
export type ImageSize = {
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
  height: number;
};

/**
 * The image MIME types a local asset may have.
 *
 * @example
 * ```ts
 * ASSET_IMAGE_MIME_TYPES.includes("image/webp"); // => true
 * ```
 */
export const ASSET_IMAGE_MIME_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];

/**
 * An asset image must be smaller than this, in bytes (30 MB).
 *
 * @example
 * ```ts
 * MAX_ASSET_IMAGE_BYTES; // => 31457280
 * ```
 */
export const MAX_ASSET_IMAGE_BYTES = 30 * 1024 * 1024;

/** Shortest allowed side, px. */
const MIN_SIDE = 300;

/** Longest allowed side, px. */
const MAX_SIDE = 6000;

/** Smallest allowed width/height ratio. */
const MIN_RATIO = 0.4;

/** Largest allowed width/height ratio. */
const MAX_RATIO = 2.5;

/** Bytes per MB, for the size message. */
const BYTES_PER_MB = 1024 * 1024;

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
 * ascii(new Uint8Array([0x57, 0x45, 0x42, 0x50]), 0, 4); // => "WEBP"
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
 * byteAt(new Uint8Array([0x89]), 1); // => 0
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
 * uint16BE(new Uint8Array([0x04, 0x00]), 0); // => 1024
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
 * uint16LE(new Uint8Array([0x00, 0x04]), 0); // => 1024
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
 * uint24LE(new Uint8Array([0xff, 0x03, 0x00]), 0); // => 1023
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
 * uint32BE(new Uint8Array([0x00, 0x00, 0x04, 0x00]), 0); // => 1024
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
 * imageSize(new Uint8Array([1, 2, 3])); // => undefined
 * ```
 */
export function imageSize(bytes: Uint8Array): ImageSize | undefined {
  return pngSize(bytes) ?? jpegSize(bytes) ?? webpSize(bytes);
}

/**
 * Whether one side of an asset image is within the allowed pixel range.
 *
 * @param side - Width or height, px.
 * @returns True for 300 to 6000 px.
 * @example
 * ```ts
 * isSideInRange(299); // => false
 * ```
 */
function isSideInRange(side: number): boolean {
  return side >= MIN_SIDE && side <= MAX_SIDE;
}

/**
 * Checks a local asset image against the documented CreateAsset limits:
 * MIME type, file size, each side, then the width/height ratio.
 *
 * @param bytes - The image bytes.
 * @param mimeType - The file's MIME type.
 * @param name - The asset's display name, for the messages.
 * @returns The image size.
 * @throws {Error} A plain two-line error naming the broken limit.
 * @example
 * ```ts
 * checkAssetImage(new Uint8Array([1, 2, 3]), "image/gif", "mira.gif");
 * // throws: '[ai] ark asset image "mira.gif" is image/gif.\n  Use a PNG, JPEG or WebP file.'
 * ```
 */
export function checkAssetImage(bytes: Uint8Array, mimeType: string, name: string): ImageSize {
  if (!ASSET_IMAGE_MIME_TYPES.includes(mimeType)) {
    throw new Error(
      `[ai] ark asset image "${name}" is ${mimeType}.\n  Use a PNG, JPEG or WebP file.`
    );
  }
  if (bytes.length >= MAX_ASSET_IMAGE_BYTES) {
    const megabytes = (bytes.length / BYTES_PER_MB).toFixed(1);
    throw new Error(
      `[ai] ark asset image "${name}" is ${megabytes} MB; it must be under 30 MB.\n  Use a smaller file.`
    );
  }

  // Width and height come from the header; an unreadable header is its own error.
  const size = imageSize(bytes);
  if (size === undefined) {
    throw new Error(
      `[ai] ark cannot read the image size of "${name}".\n  Use a PNG, JPEG or WebP file.`
    );
  }

  const { width, height } = size;
  if (!isSideInRange(width) || !isSideInRange(height)) {
    throw new Error(
      `[ai] ark asset image "${name}" is ${width}x${height} px; each side must be ${MIN_SIDE} to ${MAX_SIDE} px.\n  Resize the image.`
    );
  }
  const ratio = width / height;
  if (ratio < MIN_RATIO || ratio > MAX_RATIO) {
    throw new Error(
      `[ai] ark asset image "${name}" has a width/height ratio of ${ratio.toFixed(2)}; it must be ${MIN_RATIO} to ${MAX_RATIO}.\n  Crop the image.`
    );
  }
  return size;
}

/**
 * Reads a local asset image's bytes.
 *
 * @param file - The asset image file.
 * @returns The bytes.
 * @throws {Error} A plain two-line error when the file cannot be read.
 */
export async function readAssetImage(file: AssetFile): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(file.path));
  } catch {
    throw new Error(
      `[ai] Cannot read ark asset image "${file.path}".\n  Check that the $ref or $file it came from still exists.`
    );
  }
}
