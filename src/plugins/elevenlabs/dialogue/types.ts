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
 * Which edges of a cut window are clamped by a neighbour's speech. A clamped
 * edge rounds inward (never a frame that overlaps the neighbour); a free edge
 * rounds outward.
 *
 * @example
 * ```ts
 * const edges: CutEdges = { clampedFrom: false, clampedTo: true };
 * ```
 */
export type CutEdges = {
  /** The start is the previous line's speech end: round it up. */
  clampedFrom: boolean;
  /** The end is the next line's speech start: round it down. */
  clampedTo: boolean;
};

/**
 * The cut window of one line, seconds from the scene start, with its
 * clamped edges and the raw speech span to fall back to.
 *
 * @example
 * ```ts
 * const window: CutWindow = {
 *   index: 1,
 *   from: 2.25,
 *   to: 4.1,
 *   edges: { clampedFrom: true, clampedTo: false },
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
  /** Which edges are clamped by a neighbour. */
  edges: CutEdges;
  /** The line's raw speech span, used when the rounded window is empty. */
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
  /** Cuts `[from, to)` seconds, aligned to whole frames or samples: outward, or inward on a clamped edge. */
  cut(from: number, to: number, edges?: CutEdges): AudioPiece;
};
