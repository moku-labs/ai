/**
 * @file elevenlabs dialogue — mp3 cutter, pure TypeScript. Parses MPEG audio
 * frames (MPEG-1/2/2.5 Layer III) after an optional ID3v2 tag, drops a first
 * Xing/Info frame from timing and from cuts, and cuts by whole frames,
 * byte-for-byte (no re-encode).
 */
import type { AudioPiece, CutEdges, CuttableAudio } from "./types";

/** Layer III bitrates, kbps, by bitrate index, for MPEG-1. */
const MPEG1_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];

/** Layer III bitrates, kbps, by bitrate index, for MPEG-2 and MPEG-2.5. */
const MPEG2_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/** Sample rates, Hz, by version bits (0 = MPEG-2.5, 2 = MPEG-2, 3 = MPEG-1) and rate index. */
const SAMPLE_RATES: Readonly<Record<number, readonly number[]>> = {
  0: [11_025, 12_000, 8000],
  2: [22_050, 24_000, 16_000],
  3: [44_100, 48_000, 32_000]
};

/** Version bits of MPEG-1. */
const MPEG1 = 3;

/** Layer bits of Layer III. */
const LAYER_III = 1;

/** Channel-mode bits of a mono stream. */
const MONO = 3;

/** Layer III side-information length, bytes, by MPEG family and channel layout (where a Xing tag starts). */
const SIDE_INFO_LENGTH = {
  mpeg1: { mono: 17, stereo: 32 },
  mpeg2: { mono: 9, stereo: 17 }
} as const;

/** Length of an ID3v2 header (and of its optional footer). */
const ID3_HEADER_LENGTH = 10;

/** Length of an MPEG audio frame header. */
const FRAME_HEADER_LENGTH = 4;

/** Absorbs floating-point noise when a window edge falls on a frame boundary. */
const EPSILON = 1e-9;

/** One parsed MPEG audio frame. */
type Frame = {
  /** Byte offset of the frame header. */
  offset: number;
  /** Frame length in bytes, header included. */
  length: number;
  /** Duration of the frame, seconds. */
  seconds: number;
  /** Byte offset of the Xing/Info tag inside a frame of this layout. */
  tagOffset: number;
};

/**
 * Length of a leading ID3v2 tag ("ID3", syncsafe size, optional footer).
 *
 * @param bytes - The whole file.
 * @returns Bytes to skip before the first frame; 0 without a tag.
 */
function id3Length(bytes: Uint8Array): number {
  const hasTag = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
  if (!hasTag || bytes.length < ID3_HEADER_LENGTH) return 0;

  const flags = bytes[5] ?? 0;
  const size =
    ((bytes[6] ?? 0) << 21) | ((bytes[7] ?? 0) << 14) | ((bytes[8] ?? 0) << 7) | (bytes[9] ?? 0);
  const footer = (flags & 0x10) === 0 ? 0 : ID3_HEADER_LENGTH;
  return ID3_HEADER_LENGTH + size + footer;
}

/**
 * Reads the Layer III frame header at `offset`.
 *
 * @param bytes - The whole file.
 * @param offset - Where the header would start.
 * @returns The frame, or undefined when no valid Layer III header is there.
 */
function frameAt(bytes: Uint8Array, offset: number): Frame | undefined {
  const [b0, b1, b2, b3] = [bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]];
  if (b0 !== 0xff || b1 === undefined || b2 === undefined || b3 === undefined) return undefined;
  if ((b1 & 0xe0) !== 0xe0) return undefined;

  const version = (b1 >> 3) & 0x03;
  const layer = (b1 >> 1) & 0x03;
  const sampleRate = SAMPLE_RATES[version]?.[(b2 >> 2) & 0x03];
  const isMpeg1 = version === MPEG1;
  const kbps = (isMpeg1 ? MPEG1_BITRATES : MPEG2_BITRATES)[(b2 >> 4) & 0x0f];
  if (layer !== LAYER_III || sampleRate === undefined || kbps === undefined || kbps === 0) {
    return undefined;
  }

  const padding = (b2 >> 1) & 0x01;
  const samples = isMpeg1 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * kbps * 1000) / sampleRate) + padding;
  const isMono = ((b3 >> 6) & 0x03) === MONO;
  const sideInfo = SIDE_INFO_LENGTH[isMpeg1 ? "mpeg1" : "mpeg2"][isMono ? "mono" : "stereo"];
  return {
    offset,
    length,
    seconds: samples / sampleRate,
    tagOffset: FRAME_HEADER_LENGTH + sideInfo
  };
}

/**
 * Tells whether `frame` is a Xing/Info header frame rather than audio.
 *
 * @param bytes - The whole file.
 * @param frame - The first frame of the stream.
 * @returns True when the frame carries a "Xing" or "Info" tag.
 */
function isInfoFrame(bytes: Uint8Array, frame: Frame): boolean {
  const start = frame.offset + frame.tagOffset;
  const tag = String.fromCodePoint(...bytes.subarray(start, start + 4));
  return tag === "Xing" || tag === "Info";
}

/**
 * Walks the frames of the file: from after the ID3v2 tag, frame by frame,
 * resyncing byte by byte past anything that is not a whole frame.
 *
 * @param bytes - The whole file.
 * @returns The complete frames, in order.
 */
function framesOf(bytes: Uint8Array): Frame[] {
  const frames: Frame[] = [];
  let offset = id3Length(bytes);

  while (offset + FRAME_HEADER_LENGTH <= bytes.length) {
    const frame = frameAt(bytes, offset);
    const isWhole = frame !== undefined && frame.offset + frame.length <= bytes.length;
    if (!isWhole) {
      offset += 1;
      continue;
    }
    frames.push(frame);
    offset += frame.length;
  }
  return frames;
}

/**
 * Opens an mp3 for cutting: parses its frames and drops a first Xing/Info
 * frame. A cut is the frames whose start lies in
 * `[floor-frame(from), ceil-frame(to))`, concatenated byte-for-byte.
 *
 * @param bytes - The whole mp3 file.
 * @returns The cuttable audio, or undefined when it has no readable audio frame.
 * @example
 * ```ts
 * const audio = openMp3(sceneBytes);
 * const piece = audio?.cut(0.95, 2.4); // whole frames, ~26 ms each at 44.1 kHz
 * ```
 */
export function openMp3(bytes: Uint8Array): CuttableAudio | undefined {
  const all = framesOf(bytes);
  const [first] = all;
  const frames = first !== undefined && isInfoFrame(bytes, first) ? all.slice(1) : all;
  const [audioStart] = frames;
  if (audioStart === undefined) return undefined;

  // ElevenLabs encodes at one rate, so one frame duration times every frame.
  const frameSeconds = audioStart.seconds;
  return {
    durationSeconds: frames.length * frameSeconds,
    /**
     * Cuts `[from, to)` seconds, aligned outward to whole frames.
     *
     * @param from - Start of the window, seconds.
     * @param to - End of the window, seconds.
     * @param edges - Clamped edges round inward (never a frame that overlaps a neighbour); default outward.
     * @returns The cut bytes and the window they really cover (empty when inward rounding leaves nothing).
     */
    cut(from: number, to: number, edges?: CutEdges): AudioPiece {
      const startAt = from / frameSeconds;
      const endAt = to / frameSeconds;
      const firstIndex = Math.max(
        0,
        edges?.clampedFrom ? Math.ceil(startAt - EPSILON) : Math.floor(startAt + EPSILON)
      );
      const endIndex = Math.min(
        frames.length,
        edges?.clampedTo ? Math.floor(endAt + EPSILON) : Math.ceil(endAt - EPSILON)
      );
      const picked = frames.slice(firstIndex, Math.max(endIndex, firstIndex));
      const chunks = picked.map(frame => bytes.subarray(frame.offset, frame.offset + frame.length));
      return {
        bytes: concat(chunks),
        startSeconds: firstIndex * frameSeconds,
        endSeconds: (firstIndex + picked.length) * frameSeconds
      };
    }
  };
}

/**
 * Concatenates byte chunks into one array.
 *
 * @param chunks - The chunks, in order.
 * @returns One array holding every chunk.
 */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
