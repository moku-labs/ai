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

/** First byte of every JPEG marker; repeated, it is a fill byte. */
const JPEG_MARKER_PREFIX = 0xff;

/** Start-of-image marker code: the second byte of every JPEG file. */
const JPEG_SOI = 0xd8;

/** Bytes in a marker: the prefix and the code. */
const JPEG_MARKER_BYTES = 2;

/** Bytes a segment needs to be walked: its marker and its 16-bit length. */
const JPEG_SEGMENT_HEADER_BYTES = 4;

/** Offset of a segment's big-endian length, from its marker. */
const JPEG_SEGMENT_LENGTH_OFFSET = 2;

/** Offset of the frame height in a start-of-frame segment, from its marker. */
const JPEG_SOF_HEIGHT_OFFSET = 5;

/** Offset of the frame width in a start-of-frame segment, from its marker. */
const JPEG_SOF_WIDTH_OFFSET = 7;

/** First marker code of the C0-CF start-of-frame range. */
const JPEG_SOF_FIRST = 0xc0;

/** Last marker code of the C0-CF start-of-frame range. */
const JPEG_SOF_LAST = 0xcf;

/** Length of a RIFF FourCC tag. */
const FOURCC_BYTES = 4;

/** Offset of the `WEBP` form type in the RIFF header. */
const WEBP_FORM_OFFSET = 8;

/** Offset of the first WebP chunk's FourCC. */
const WEBP_CHUNK_OFFSET = 12;

/** Lossy and lossless WebP store each side in 14 bits. */
const WEBP_SIDE_MASK = 0x3f_ff;

/** Offset of the lossy (`VP8 `) frame width. */
const VP8_WIDTH_OFFSET = 26;

/** Offset of the lossy (`VP8 `) frame height. */
const VP8_HEIGHT_OFFSET = 28;

/** Offset of the lossless (`VP8L`) 32-bit size word, after its 0x2f signature byte. */
const VP8L_SIZE_OFFSET = 21;

/** Bits of the lossless width field, where the height field starts. */
const VP8L_WIDTH_BITS = 14;

/** Offset of the extended (`VP8X`) canvas width minus one. */
const VP8X_WIDTH_OFFSET = 24;

/** Offset of the extended (`VP8X`) canvas height minus one. */
const VP8X_HEIGHT_OFFSET = 27;

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
 * Reads a little-endian 32-bit integer.
 *
 * @param bytes - File bytes.
 * @param offset - Offset.
 * @returns The value.
 * @example
 * ```ts
 * uint32LE(new Uint8Array([0x00, 0x04, 0x00, 0x00]), 0); // => 1024
 * ```
 */
function uint32LE(bytes: Uint8Array, offset: number): number {
  return uint16LE(bytes, offset) + uint16LE(bytes, offset + 2) * 0x1_00_00;
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
 * Whether the bytes start with the JPEG start-of-image marker.
 *
 * @param bytes - File bytes.
 * @returns True for a JPEG.
 * @example
 * ```ts
 * isJpeg(new Uint8Array([0xff, 0xd8, 0xff])); // => true
 * ```
 */
function isJpeg(bytes: Uint8Array): boolean {
  return byteAt(bytes, 0) === JPEG_MARKER_PREFIX && byteAt(bytes, 1) === JPEG_SOI;
}

/**
 * JPEG size from the first start-of-frame marker, skipping every segment
 * before it (APP0/APP1 EXIF, DQT, DHT, ...).
 *
 * @param bytes - File bytes.
 * @returns The size, or undefined when this is not a JPEG or has no SOF.
 */
function jpegSize(bytes: Uint8Array): ImageSize | undefined {
  if (!isJpeg(bytes)) return undefined;

  // Walk the segments to the first start-of-frame: step over fill bytes and
  // standalone markers, jump over every other segment by its length.
  let offset = JPEG_MARKER_BYTES;
  while (offset + JPEG_SEGMENT_HEADER_BYTES <= bytes.length) {
    if (byteAt(bytes, offset) !== JPEG_MARKER_PREFIX) return undefined;
    const marker = byteAt(bytes, offset + 1);
    if (marker === JPEG_MARKER_PREFIX) {
      offset += 1;
      continue;
    }
    if (STANDALONE_JPEG_MARKERS.has(marker)) {
      offset += JPEG_MARKER_BYTES;
      continue;
    }

    const isStartOfFrame =
      marker >= JPEG_SOF_FIRST && marker <= JPEG_SOF_LAST && !NON_SOF_MARKERS.has(marker);
    if (isStartOfFrame) {
      return positiveSize(
        uint16BE(bytes, offset + JPEG_SOF_WIDTH_OFFSET),
        uint16BE(bytes, offset + JPEG_SOF_HEIGHT_OFFSET)
      );
    }
    offset += JPEG_MARKER_BYTES + uint16BE(bytes, offset + JPEG_SEGMENT_LENGTH_OFFSET);
  }
  return undefined;
}

/**
 * Whether the bytes are a RIFF container of form type `WEBP`.
 *
 * @param bytes - File bytes.
 * @returns True for a WebP.
 * @example
 * ```ts
 * isWebp(new TextEncoder().encode("RIFF\0\0\0\0WEBP")); // => true
 * ```
 */
function isWebp(bytes: Uint8Array): boolean {
  return (
    ascii(bytes, 0, FOURCC_BYTES) === "RIFF" &&
    ascii(bytes, WEBP_FORM_OFFSET, FOURCC_BYTES) === "WEBP"
  );
}

/**
 * Lossless WebP size from the bit-packed `VP8L` header.
 *
 * @param bytes - File bytes (a WebP whose first chunk is `VP8L`).
 * @returns The size.
 * @example
 * ```ts
 * losslessWebpSize(new Uint8Array(25)); // => { width: 1, height: 1 }
 * ```
 */
function losslessWebpSize(bytes: Uint8Array): ImageSize | undefined {
  // One little-endian 32-bit word: width - 1 in bits 0-13, height - 1 in bits 14-27, then alpha and version.
  const bits = uint32LE(bytes, VP8L_SIZE_OFFSET);
  const width = 1 + (bits & WEBP_SIDE_MASK);
  const height = 1 + ((bits >>> VP8L_WIDTH_BITS) & WEBP_SIDE_MASK);
  return positiveSize(width, height);
}

/**
 * WebP size from its first chunk: lossy (`VP8 `), lossless (`VP8L`) or
 * extended (`VP8X`).
 *
 * @param bytes - File bytes.
 * @returns The size, or undefined when this is not a WebP.
 */
function webpSize(bytes: Uint8Array): ImageSize | undefined {
  if (!isWebp(bytes)) return undefined;

  const chunk = ascii(bytes, WEBP_CHUNK_OFFSET, FOURCC_BYTES);
  if (chunk === "VP8 ") {
    return positiveSize(
      uint16LE(bytes, VP8_WIDTH_OFFSET) & WEBP_SIDE_MASK,
      uint16LE(bytes, VP8_HEIGHT_OFFSET) & WEBP_SIDE_MASK
    );
  }
  if (chunk === "VP8L") return losslessWebpSize(bytes);
  if (chunk === "VP8X") {
    return positiveSize(
      1 + uint24LE(bytes, VP8X_WIDTH_OFFSET),
      1 + uint24LE(bytes, VP8X_HEIGHT_OFFSET)
    );
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
  // Refuse a wrong file type or an oversized file before parsing any header.
  if (!ASSET_IMAGE_MIME_TYPES.includes(mimeType)) {
    throw new Error(
      `[ai] ark asset image "${name}" is ${mimeType}.\n  Use a PNG, JPEG or WebP file.`
    );
  }
  if (bytes.length >= MAX_ASSET_IMAGE_BYTES) {
    const megabytes = (bytes.length / BYTES_PER_MB).toFixed(1);
    const maxMegabytes = MAX_ASSET_IMAGE_BYTES / BYTES_PER_MB;
    throw new Error(
      `[ai] ark asset image "${name}" is ${megabytes} MB; it must be under ${maxMegabytes} MB.\n  Use a smaller file.`
    );
  }

  // Width and height come from the header; an unreadable header is its own error.
  const size = imageSize(bytes);
  if (size === undefined) {
    throw new Error(
      `[ai] ark cannot read the image size of "${name}".\n  Use a PNG, JPEG or WebP file.`
    );
  }

  // Hold the size to the documented limits: each side, then the width/height ratio.
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
