/**
 * @file elevenlabs dialogue — cut planner, pure. Turns the response's voice
 * segments into one window per line (padding, clamped to the neighbours'
 * speech so a cut never carries the next line's first syllable), then cuts
 * the scene audio with the mp3 or wav cutter.
 */
import { LocalFailureError } from "../errors";
import { openMp3 } from "./mp3";
import type { AudioPiece, CuttableAudio, CutWindow, VoiceSegment } from "./types";
import { openWav } from "./wav";

/** Padding before a line's first word, seconds. */
const LEAD_SECONDS = 0.05;

/** Padding after a line's last word, seconds (room for a breath or a reverb tail). */
const TAIL_SECONDS = 0.15;

/** The message of an audio that cannot be cut. */
const UNREADABLE_AUDIO =
  "[ai] Could not cut the ElevenLabs dialogue audio.\n  The response audio has no readable mp3 frames or wav data.";

/** Where one line's speech starts and ends, seconds. */
type Speech = { start: number; end: number };

/**
 * One line's cut: its index, the audio piece, and nothing else (the handler
 * adds the id and the mime type).
 *
 * @example
 * ```ts
 * const cut: LineCut = { index: 0, piece: { bytes, startSeconds: 0, endSeconds: 1.02 } };
 * ```
 */
export type LineCut = {
  /** Index of the line in the request's `lines`. */
  index: number;
  /** The cut audio and the window it covers. */
  piece: AudioPiece;
};

/**
 * The speech span of every line that has segments: the earliest start and
 * the latest end over its segments.
 *
 * @param segments - The response's voice segments.
 * @param lineCount - How many lines the request had.
 * @returns The speech span by line index; `undefined` for a line with no segment.
 */
function speechByLine(
  segments: readonly VoiceSegment[],
  lineCount: number
): (Speech | undefined)[] {
  const spans: (Speech | undefined)[] = Array.from<Speech | undefined>({ length: lineCount });
  for (const segment of segments) {
    if (segment.lineIndex < 0 || segment.lineIndex >= lineCount) continue;
    const span = spans[segment.lineIndex];
    spans[segment.lineIndex] = {
      start: Math.min(span?.start ?? segment.startSeconds, segment.startSeconds),
      end: Math.max(span?.end ?? segment.endSeconds, segment.endSeconds)
    };
  }
  return spans;
}

/**
 * The nearest line by index, in one direction, that has speech.
 *
 * @param spans - The speech span by line index.
 * @param from - The line to look from.
 * @param step - -1 for the previous line, +1 for the next.
 * @returns The neighbour's speech, or undefined when there is none.
 */
function neighbourSpeech(
  spans: readonly (Speech | undefined)[],
  from: number,
  step: -1 | 1
): Speech | undefined {
  for (let index = from + step; index >= 0 && index < spans.length; index += step) {
    const span = spans[index];
    if (span !== undefined) return span;
  }
  return undefined;
}

/**
 * The cut window of one line that has speech: padded speech, clamped to the
 * neighbours' speech, which is also its hard bound.
 *
 * @param index - The line's index.
 * @param span - The line's own speech span.
 * @param spans - The speech span by line index (for the neighbours).
 * @param durationSeconds - Length of the scene audio, seconds.
 * @returns The window; the raw speech span, unbounded, when the clamp leaves nothing.
 */
function windowOf(
  index: number,
  span: Speech,
  spans: readonly (Speech | undefined)[],
  durationSeconds: number
): CutWindow {
  // The neighbours' speech bounds the window: no frame of it may enter the cut.
  const previous = neighbourSpeech(spans, index, -1);
  const next = neighbourSpeech(spans, index, 1);
  const hard = { from: previous?.end ?? 0, to: next?.start ?? durationSeconds };

  // Pad the speech, then clamp to the bounds and to the audio.
  const from = Math.max(span.start - LEAD_SECONDS, hard.from, 0);
  const to = Math.min(span.end + TAIL_SECONDS, hard.to, durationSeconds);
  const speech = { from: span.start, to: span.end };

  // Overlapping speech can clamp the window away: fall back to the raw span.
  const isClampedAway = to <= from;
  return isClampedAway
    ? { index, ...speech, hard: { from: 0, to: durationSeconds }, speech }
    : { index, from, to, hard, speech };
}

/**
 * Plans the cut window of every line. Window of line i:
 * `from = max(start_i − 0.050, end_prev, 0)`,
 * `to = min(end_i + 0.150, start_next, duration)`, where prev/next are the
 * nearest lines by index that have speech. Their speech is also the
 * window's hard bound: the cutter rounds outward, then clips inside it, so
 * no cut holds a frame of a neighbour's speech. When the clamp leaves
 * nothing (`to ≤ from`, overlapping speech), the raw speech span is used,
 * unbounded.
 *
 * @param segments - The response's voice segments.
 * @param lineCount - How many lines the request had.
 * @param durationSeconds - Length of the scene audio, seconds.
 * @returns The windows of the lines that have speech, and the indexes of those that have none.
 * @example
 * ```ts
 * planCutWindows([{ lineIndex: 0, startSeconds: 0.2, endSeconds: 1 }], 2, 3);
 * // => {
 * //   windows: [{ index: 0, from ≈ 0.15, to ≈ 1.15, hard: { from: 0, to: 3 }, speech: { from: 0.2, to: 1 } }],
 * //   missing: [1]
 * // }
 * ```
 */
export function planCutWindows(
  segments: readonly VoiceSegment[],
  lineCount: number,
  durationSeconds: number
): { windows: CutWindow[]; missing: number[] } {
  const spans = speechByLine(segments, lineCount);
  const windows: CutWindow[] = [];
  const missing: number[] = [];

  for (const [index, span] of spans.entries()) {
    // A line with no segment has no speech to cut: report it.
    if (span === undefined) {
      missing.push(index);
      continue;
    }
    windows.push(windowOf(index, span, spans, durationSeconds));
  }
  return { windows, missing };
}

/**
 * Opens the scene audio with the cutter of its output format.
 *
 * @param audio - The scene audio bytes.
 * @param formatCode - The ElevenLabs output format code (`mp3_*` or `wav_*`).
 * @returns The cuttable audio.
 * @throws {LocalFailureError} When the audio has no readable frame or data chunk.
 */
function openAudio(audio: Uint8Array, formatCode: string): CuttableAudio {
  const opened = formatCode.startsWith("wav_") ? openWav(audio) : openMp3(audio);
  if (opened === undefined) throw new LocalFailureError(UNREADABLE_AUDIO);
  return opened;
}

/**
 * Cuts one window inside its hard bounds; when that leaves no whole frame or
 * sample, the raw speech span, rounded outward and unbounded.
 *
 * @param opened - The cuttable scene audio.
 * @param window - The line's window.
 * @returns The cut piece.
 */
function cutWindow(opened: CuttableAudio, window: CutWindow): AudioPiece {
  const piece = opened.cut(window.from, window.to, window.hard);
  const isEmpty = piece.endSeconds <= piece.startSeconds;
  return isEmpty ? opened.cut(window.speech.from, window.speech.to) : piece;
}

/**
 * Cuts the scene audio into one piece per line that has speech.
 *
 * @param audio - The scene audio bytes.
 * @param formatCode - The ElevenLabs output format code (`mp3_*` or `wav_*`).
 * @param segments - The response's voice segments.
 * @param lineCount - How many lines the request had.
 * @returns The cuts in line order, and the indexes of the lines with no segment.
 * @throws {LocalFailureError} When the audio has no readable mp3 frame or wav data.
 * @example
 * ```ts
 * // `sceneMp3`: a 3 s mp3 at 44.1 kHz (frames of ≈ 0.026 s); the second line has no segment.
 * cutDialogue(sceneMp3, "mp3_44100_128", [{ lineIndex: 0, startSeconds: 0.2, endSeconds: 1 }], 2);
 * // => { cuts: [{ index: 0, piece: { bytes, startSeconds ≈ 0.13, endSeconds ≈ 1.18 } }], missing: [1] }
 * ```
 */
export function cutDialogue(
  audio: Uint8Array,
  formatCode: string,
  segments: readonly VoiceSegment[],
  lineCount: number
): { cuts: LineCut[]; missing: number[] } {
  const opened = openAudio(audio, formatCode);
  const { windows, missing } = planCutWindows(segments, lineCount, opened.durationSeconds);
  const cuts = windows.map(window => ({ index: window.index, piece: cutWindow(opened, window) }));
  return { cuts, missing };
}
