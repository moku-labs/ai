/**
 * @file elevenlabs dialogue — wav cutter, pure TypeScript. Walks the RIFF
 * chunks to `fmt ` and `data`, cuts sample-accurately on block-align
 * boundaries and writes each cut with a fresh 44-byte header.
 */
import type { AudioPiece, CutBounds, CuttableAudio } from "./types";

/** Length of the canonical PCM wav header this cutter writes. */
const HEADER_LENGTH = 44;

/** Length of a RIFF chunk header (id + size). */
const CHUNK_HEADER_LENGTH = 8;

/** Length of the RIFF container header: "RIFF", the size, "WAVE". Chunks start after it. */
const RIFF_HEADER_LENGTH = 12;

/** Smallest `fmt ` body this reader takes: the PCM fields up to `bitsPerSample`. */
const MIN_FMT_SIZE = 16;

/** Byte offsets inside the 44-byte header this cutter writes. */
const HEADER = {
  riffSize: 4,
  waveTag: 8,
  fmtTag: 12,
  fmtSize: 16,
  audioFormat: 20,
  channels: 22,
  sampleRate: 24,
  byteRate: 28,
  blockAlign: 32,
  bitsPerSample: 34,
  dataTag: 36,
  dataSize: 40
} as const;

/** Absorbs floating-point noise when a window edge falls on a sample boundary. */
const EPSILON = 1e-9;

/** The format tag of WAVE_FORMAT_EXTENSIBLE: the real code is the sub-format's first two bytes. */
const WAVE_FORMAT_EXTENSIBLE = 0xff_fe;

/** Offset of the sub-format GUID inside an extensible `fmt ` body. */
const SUB_FORMAT_OFFSET = 24;

/** Length of a RIFF four-character id. */
const FOUR_CC_LENGTH = 4;

/** Offset of the size field inside a RIFF chunk header (after the id). */
const CHUNK_SIZE_OFFSET = FOUR_CC_LENGTH;

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
  return String.fromCodePoint(...bytes.subarray(offset, offset + FOUR_CC_LENGTH));
}

/**
 * Reads the `fmt ` chunk body. For WAVE_FORMAT_EXTENSIBLE the format code is
 * taken from the sub-format (PCM 1, float 3), so a cut's plain 16-byte
 * header stays valid.
 *
 * @param view - A view over the whole file.
 * @param offset - Where the chunk body starts (at least 16 bytes are present).
 * @param size - The chunk body size.
 * @returns The format fields.
 */
function formatAt(view: DataView, offset: number, size: number): WavFormat {
  const tag = view.getUint16(offset, true);
  const subFormatAt = offset + SUB_FORMAT_OFFSET;
  const hasSubFormat = size >= SUB_FORMAT_OFFSET + 2 && subFormatAt + 2 <= view.byteLength;
  const isExtensible = tag === WAVE_FORMAT_EXTENSIBLE && hasSubFormat;
  return {
    audioFormat: isExtensible ? view.getUint16(subFormatAt, true) : tag,
    channels: view.getUint16(offset + 2, true),
    sampleRate: view.getUint32(offset + 4, true),
    byteRate: view.getUint32(offset + 8, true),
    blockAlign: view.getUint16(offset + 12, true),
    bitsPerSample: view.getUint16(offset + 14, true)
  };
}

/**
 * Reads a `fmt ` chunk when its body is whole.
 *
 * @param view - A view over the whole file.
 * @param body - Where the chunk body starts.
 * @param size - The chunk body size, as declared.
 * @returns The format fields, or undefined when the body is too small or cut off.
 */
function readFmtChunk(view: DataView, body: number, size: number): WavFormat | undefined {
  const isWhole = size >= MIN_FMT_SIZE && body + MIN_FMT_SIZE <= view.byteLength;
  return isWhole ? formatAt(view, body, size) : undefined;
}

/** A `fmt ` or `data` chunk handled: keep walking, give up, or finish with the result. */
type ChunkStep =
  | { kind: "next"; format: WavFormat | undefined }
  | { kind: "stop" }
  | { kind: "done"; result: { format: WavFormat; data: Uint8Array } };

/**
 * Handles one chunk: `fmt ` records the format, `data` ends the walk, any
 * other chunk changes nothing.
 *
 * @param bytes - The whole file.
 * @param view - A view over the whole file.
 * @param chunk - The chunk to handle.
 * @param chunk.id - The chunk id.
 * @param chunk.body - Where the chunk body starts.
 * @param chunk.size - The declared body size.
 * @param format - The format found so far.
 * @returns What the walk does next.
 */
function stepChunk(
  bytes: Uint8Array,
  view: DataView,
  chunk: { id: string; body: number; size: number },
  format: WavFormat | undefined
): ChunkStep {
  const { id, body, size } = chunk;
  if (id === "fmt ") {
    const read = readFmtChunk(view, body, size);
    return read === undefined ? { kind: "stop" } : { kind: "next", format: read };
  }
  if (id === "data") {
    const data = bytes.subarray(body, Math.min(body + size, bytes.length));
    return format === undefined ? { kind: "stop" } : { kind: "done", result: { format, data } };
  }
  return { kind: "next", format };
}

/**
 * Walks the RIFF chunks to the format and the sample data. A `data` size past
 * the end of the file (a streamed wav) is cut to the bytes present.
 *
 * @param bytes - The whole file.
 * @returns The format and the sample bytes, or undefined when either is missing.
 */
function chunksOf(bytes: Uint8Array): { format: WavFormat; data: Uint8Array } | undefined {
  // The container: "RIFF" ... "WAVE".
  const isWave = fourCcAt(bytes, 0) === "RIFF" && fourCcAt(bytes, HEADER.waveTag) === "WAVE";
  if (!isWave) return undefined;

  // Walk the chunks; the format must come before the data.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: WavFormat | undefined;
  let offset = RIFF_HEADER_LENGTH;
  while (offset + CHUNK_HEADER_LENGTH <= bytes.length) {
    const id = fourCcAt(bytes, offset);
    const size = view.getUint32(offset + CHUNK_SIZE_OFFSET, true);
    const body = offset + CHUNK_HEADER_LENGTH;

    const step = stepChunk(bytes, view, { id, body, size }, format);
    if (step.kind === "stop") return undefined;
    if (step.kind === "done") return step.result;
    format = step.format;

    // Chunks are word-aligned: an odd size carries one pad byte.
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

  // The RIFF container: everything after the first eight bytes is its size.
  writeText(0, "RIFF");
  view.setUint32(HEADER.riffSize, HEADER_LENGTH - CHUNK_HEADER_LENGTH + data.length, true);
  writeText(HEADER.waveTag, "WAVE");

  // The fmt chunk: the source format, copied.
  writeText(HEADER.fmtTag, "fmt ");
  view.setUint32(HEADER.fmtSize, MIN_FMT_SIZE, true);
  view.setUint16(HEADER.audioFormat, format.audioFormat, true);
  view.setUint16(HEADER.channels, format.channels, true);
  view.setUint32(HEADER.sampleRate, format.sampleRate, true);
  view.setUint32(HEADER.byteRate, format.byteRate, true);
  view.setUint16(HEADER.blockAlign, format.blockAlign, true);
  view.setUint16(HEADER.bitsPerSample, format.bitsPerSample, true);

  // The data chunk: the cut samples.
  writeText(HEADER.dataTag, "data");
  view.setUint32(HEADER.dataSize, data.length, true);
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
     * Cuts `[from, to)` seconds (contract: `CuttableAudio.cut`).
     *
     * @param from - Start of the window, seconds.
     * @param to - End of the window, seconds.
     * @param hard - Bounds no sample may cross; unbounded when absent.
     * @returns The cut bytes and the window they really cover.
     */
    cut(from: number, to: number, hard?: CutBounds): AudioPiece {
      // Sample frames wholly inside the hard bounds (all of them when unbounded).
      const rate = format.sampleRate;
      const lowest = hard === undefined ? 0 : Math.ceil(hard.from * rate - EPSILON);
      const highest = hard === undefined ? totalFrames : Math.floor(hard.to * rate + EPSILON);

      // The window rounded outward to sample frames, then clipped inside those bounds.
      const firstFrame = Math.max(0, lowest, Math.floor(from * rate + EPSILON));
      const endFrame = Math.min(totalFrames, highest, Math.ceil(to * rate - EPSILON));
      const lastFrame = Math.max(endFrame, firstFrame);

      // The chosen samples under a fresh header; an empty window gives an empty wav.
      const samples = data.subarray(firstFrame * format.blockAlign, lastFrame * format.blockAlign);
      return {
        bytes: wavFile(format, samples),
        startSeconds: firstFrame / format.sampleRate,
        endSeconds: lastFrame / format.sampleRate
      };
    }
  };
}
