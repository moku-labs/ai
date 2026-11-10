/**
 * @file elevenlabs dialogue submodule — types shared by the response reader,
 * the cut planner and the mp3/wav cutters. Types only.
 */

/**
 * One voice segment of a `/v1/text-to-dialogue/with-timestamps` response, as
 * far as the cutter reads it.
 *
 * @example
 * ```ts
 * const segment: VoiceSegment = { lineIndex: 0, startSeconds: 0.12, endSeconds: 2.3 };
 * ```
 */
export type VoiceSegment = {
  /** `dialogue_input_index`: the index of the line this segment speaks. */
  lineIndex: number;
  /** `start_time_seconds`: where the segment's speech starts in the scene audio. */
  startSeconds: number;
  /** `end_time_seconds`: where the segment's speech ends in the scene audio. */
  endSeconds: number;
};

/**
 * Hard bounds of a cut: the neighbours' speech. Whatever the rounding, a cut
 * starts at or after `from` and ends at or before `to`, so it never holds a
 * frame or sample that overlaps a neighbour's speech.
 *
 * @example
 * ```ts
 * const hard: CutBounds = { from: 2.2, to: 4.3 }; // previous line's end, next line's start
 * ```
 */
export type CutBounds = {
  /** The previous line's speech end (0 without one), seconds. */
  from: number;
  /** The next line's speech start (the duration without one), seconds. */
  to: number;
};

/**
 * The cut window of one line, seconds from the scene start, with its hard
 * bounds and the raw speech span to fall back to.
 *
 * @example
 * ```ts
 * const window: CutWindow = {
 *   index: 1,
 *   from: 2.25,
 *   to: 4.1,
 *   hard: { from: 2.2, to: 4.3 },
 *   speech: { from: 2.3, to: 3.95 }
 * };
 * ```
 */
export type CutWindow = {
  /** Index of the line in the request's `lines`. */
  index: number;
  /** Start of the window, seconds. */
  from: number;
  /** End of the window, seconds. */
  to: number;
  /** The neighbours' speech, which no rounding crosses. */
  hard: CutBounds;
  /** The line's raw speech span, used when the bounded window is empty. */
  speech: { from: number; to: number };
};

/**
 * One piece cut out of the scene audio: its bytes and the window it really
 * covers after aligning to frames (mp3) or samples (wav).
 *
 * @example
 * ```ts
 * const piece: AudioPiece = { bytes: new Uint8Array(), startSeconds: 0, endSeconds: 1.02 };
 * ```
 */
export type AudioPiece = {
  /** A playable file of the cut: whole mp3 frames, or a wav with a fresh header. */
  bytes: Uint8Array;
  /** Where the cut starts, seconds from the scene start. */
  startSeconds: number;
  /** Where the cut ends, seconds from the scene start. */
  endSeconds: number;
};

/**
 * Parsed scene audio that can be cut without re-encoding.
 *
 * @example
 * ```ts
 * const audio: CuttableAudio = openMp3(bytes) ?? fail();
 * const piece = audio.cut(0.5, 1.2);
 * ```
 */
export type CuttableAudio = {
  /** Length of the audio, seconds (mp3: audio frames only, Xing/Info frame excluded). */
  durationSeconds: number;
  /** Cuts `[from, to)` seconds, rounded outward to whole frames or samples, then clipped inside `hard`. */
  cut(from: number, to: number, hard?: CutBounds): AudioPiece;
};
