/**
 * @file elevenlabs dialogue — cut planner, pure. Turns the response's voice
 * segments into one window per line (padding, clamped to the neighbours'
 * speech so a cut never carries the next line's first syllable), then cuts
 * the scene audio with the mp3 or wav cutter.
 */
import { LocalFailureError } from "../errors";
import { openMp3 } from "./mp3";
import type { AudioPiece, CutEdges, CuttableAudio, CutWindow, VoiceSegment } from "./types";
import { openWav } from "./wav";

/** Padding before a line's first word, seconds. */
const LEAD_SECONDS = 0.05;

/** Padding after a line's last word, seconds (room for a breath or a reverb tail). */
const TAIL_SECONDS = 0.15;

/** The message of an audio that cannot be cut. */
const UNREADABLE_AUDIO =
  "[ai] Could not cut the ElevenLabs dialogue audio.\n  The response audio has no readable mp3 frames or wav data.";

/** Edges that round outward: neither is clamped by a neighbour. */
const FREE_EDGES: CutEdges = { clampedFrom: false, clampedTo: false };

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
 * Which edges a neighbour sets: the previous line's speech end at or after
 * the lead, the next line's speech start at or before the tail.
 *
 * @param lead - The padded start, seconds.
 * @param tail - The padded end, seconds.
 * @param previous - The previous line's speech, if any.
 * @param next - The next line's speech, if any.
 * @returns The clamped edges.
 */
function clampedEdges(
  lead: number,
  tail: number,
  previous: Speech | undefined,
  next: Speech | undefined
): CutEdges {
  return {
    clampedFrom: previous !== undefined && previous.end >= lead,
    clampedTo: next !== undefined && next.start <= tail
  };
}

/**
 * Plans the cut window of every line. Window of line i:
 * `from = max(start_i − 0.050, end_prev, 0)`,
 * `to = min(end_i + 0.150, start_next, duration)`, where prev/next are the
 * nearest lines by index that have speech. An edge set by a neighbour is
 * marked clamped, so the cutter rounds it inward. When the clamp leaves
 * nothing (`to ≤ from`, overlapping speech), the raw speech span is used.
 *
 * @param segments - The response's voice segments.
 * @param lineCount - How many lines the request had.
 * @param durationSeconds - Length of the scene audio, seconds.
 * @returns The windows of the lines that have speech, and the indexes of those that have none.
 * @example
 * ```ts
 * planCutWindows([{ lineIndex: 0, startSeconds: 0.2, endSeconds: 1 }], 2, 3);
 * // => { windows: [{ index: 0, from: 0.15, to: 1.15, edges: { clampedFrom: false, clampedTo: false }, speech: { from: 0.2, to: 1 } }], missing: [1] }
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
    if (span === undefined) {
      missing.push(index);
      continue;
    }
    const previous = neighbourSpeech(spans, index, -1);
    const next = neighbourSpeech(spans, index, 1);
    const lead = Math.max(span.start - LEAD_SECONDS, 0);
    const tail = Math.min(span.end + TAIL_SECONDS, durationSeconds);
    const from = Math.max(lead, previous?.end ?? 0);
    const to = Math.min(tail, next?.start ?? durationSeconds);
    const speech = { from: span.start, to: span.end };
    const isClampedAway = to <= from;
    windows.push(
      isClampedAway
        ? { index, ...speech, edges: FREE_EDGES, speech }
        : { index, from, to, edges: clampedEdges(lead, tail, previous, next), speech }
    );
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
 * Cuts one window: clamped edges rounded inward; when that leaves no whole
 * frame or sample, the raw speech span rounded outward.
 *
 * @param opened - The cuttable scene audio.
 * @param window - The line's window.
 * @returns The cut piece.
 */
function cutWindow(opened: CuttableAudio, window: CutWindow): AudioPiece {
  const piece = opened.cut(window.from, window.to, window.edges);
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
 * const { cuts, missing } = cutDialogue(mix, "mp3_44100_128", segments, request.lines.length);
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
