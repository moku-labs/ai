/**
 * @file elevenlabs dialogue — wav cutter, pure TypeScript. Walks the RIFF
 * chunks to `fmt ` and `data`, cuts sample-accurately on block-align
 * boundaries and writes each cut with a fresh 44-byte header.
 */
import type { AudioPiece, CutEdges, CuttableAudio } from "./types";

/** Length of the canonical PCM wav header this cutter writes. */
const HEADER_LENGTH = 44;

/** Length of a RIFF chunk header (id + size). */
const CHUNK_HEADER_LENGTH = 8;

/** Absorbs floating-point noise when a window edge falls on a sample boundary. */
const EPSILON = 1e-9;

/** The `fmt ` fields a cut copies into its header. */
type WavFormat = {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
};

/**
 * Reads a four-character chunk id.
 *
 * @param bytes - The whole file.
 * @param offset - Where the id starts.
 * @returns The id as text.
 */
function fourCcAt(bytes: Uint8Array, offset: number): string {
  return String.fromCodePoint(...bytes.subarray(offset, offset + 4));
}

/**
 * Reads the `fmt ` chunk body.
 *
 * @param view - A view over the whole file.
 * @param offset - Where the chunk body starts.
 * @returns The format fields.
 */
function formatAt(view: DataView, offset: number): WavFormat {
  return {
    audioFormat: view.getUint16(offset, true),
    channels: view.getUint16(offset + 2, true),
    sampleRate: view.getUint32(offset + 4, true),
    byteRate: view.getUint32(offset + 8, true),
    blockAlign: view.getUint16(offset + 12, true),
    bitsPerSample: view.getUint16(offset + 14, true)
  };
}

/**
 * Walks the RIFF chunks to the format and the sample data. A `data` size past
 * the end of the file (a streamed wav) is cut to the bytes present.
 *
 * @param bytes - The whole file.
 * @returns The format and the sample bytes, or undefined when either is missing.
 */
function chunksOf(bytes: Uint8Array): { format: WavFormat; data: Uint8Array } | undefined {
  const isWave = fourCcAt(bytes, 0) === "RIFF" && fourCcAt(bytes, 8) === "WAVE";
  if (!isWave) return undefined;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: WavFormat | undefined;
  let offset = 12;
  while (offset + CHUNK_HEADER_LENGTH <= bytes.length) {
    const id = fourCcAt(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + CHUNK_HEADER_LENGTH;
    if (id === "fmt " && size >= 16) format = formatAt(view, body);
    if (id === "data") {
      const data = bytes.subarray(body, Math.min(body + size, bytes.length));
      return format === undefined ? undefined : { format, data };
    }
    offset = body + size + (size % 2);
  }
  return undefined;
}

/**
 * Writes a wav file: a fresh 44-byte header for `data`, then `data`.
 *
 * @param format - The source format.
 * @param data - The cut sample bytes.
 * @returns The playable wav file.
 */
function wavFile(format: WavFormat, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_LENGTH + data.length);
  const view = new DataView(out.buffer);
  const writeText = (offset: number, text: string): void => {
    for (const [index, char] of [...text].entries()) out[offset + index] = char.codePointAt(0) ?? 0;
  };

  writeText(0, "RIFF");
  view.setUint32(4, HEADER_LENGTH - CHUNK_HEADER_LENGTH + data.length, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format.audioFormat, true);
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.sampleRate, true);
  view.setUint32(28, format.byteRate, true);
  view.setUint16(32, format.blockAlign, true);
  view.setUint16(34, format.bitsPerSample, true);
  writeText(36, "data");
  view.setUint32(40, data.length, true);
  out.set(data, HEADER_LENGTH);
  return out;
}

/**
 * Opens a wav for cutting. Duration = data bytes / (sample rate × block
 * align); a cut is the sample frames `[floor(from × rate), ceil(to × rate))`.
 *
 * @param bytes - The whole wav file.
 * @returns The cuttable audio, or undefined when it has no `fmt ` and `data` chunk.
 * @example
 * ```ts
 * const audio = openWav(sceneBytes);
 * const piece = audio?.cut(0.95, 2.4); // sample-exact, fresh 44-byte header
 * ```
 */
export function openWav(bytes: Uint8Array): CuttableAudio | undefined {
  const chunks = chunksOf(bytes);
  if (chunks === undefined) return undefined;
  const { format, data } = chunks;
  if (format.blockAlign === 0 || format.sampleRate === 0) return undefined;

  const totalFrames = Math.floor(data.length / format.blockAlign);
  return {
    durationSeconds: totalFrames / format.sampleRate,
    /**
     * Cuts `[from, to)` seconds, aligned outward to whole sample frames.
     *
     * @param from - Start of the window, seconds.
     * @param to - End of the window, seconds.
     * @param edges - Clamped edges round inward (never a frame that overlaps a neighbour); default outward.
     * @returns The cut bytes and the window they really cover (empty when inward rounding leaves nothing).
     */
    cut(from: number, to: number, edges?: CutEdges): AudioPiece {
      const startAt = from * format.sampleRate;
      const endAt = to * format.sampleRate;
      const firstFrame = Math.max(
        0,
        edges?.clampedFrom ? Math.ceil(startAt - EPSILON) : Math.floor(startAt + EPSILON)
      );
      const endFrame = Math.min(
        totalFrames,
        edges?.clampedTo ? Math.floor(endAt + EPSILON) : Math.ceil(endAt - EPSILON)
      );
      const lastFrame = Math.max(endFrame, firstFrame);
      const samples = data.subarray(firstFrame * format.blockAlign, lastFrame * format.blockAlign);
      return {
        bytes: wavFile(format, samples),
        startSeconds: firstFrame / format.sampleRate,
        endSeconds: lastFrame / format.sampleRate
      };
    }
  };
}
