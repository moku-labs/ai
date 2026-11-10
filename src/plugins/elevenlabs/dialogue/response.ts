/**
 * @file elevenlabs dialogue — reader of the
 * `/v1/text-to-dialogue/with-timestamps` JSON response: the base64 scene
 * audio and the voice segments. The body is an untrusted boundary (spec/09
 * R9), narrowed field by field; a broken body is the provider's side.
 */
import { Buffer } from "node:buffer";
import { RetryableProviderError } from "../errors";
import type { VoiceSegment } from "./types";

/** Status of a response the provider broke. */
const BAD_GATEWAY = 502;

/**
 * The parts of a dialogue response the handler uses.
 *
 * @example
 * ```ts
 * const response: DialogueResponse = { audio: new Uint8Array(), segments: [] };
 * ```
 */
export type DialogueResponse = {
  /** The decoded scene audio. */
  audio: Uint8Array;
  /** The voice segments, with their line index and times. */
  segments: VoiceSegment[];
};

/**
 * Tells whether `value` is a finite number.
 *
 * @param value - A field of the untrusted body.
 * @returns True for a finite number.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Reads one voice segment.
 *
 * @param raw - One entry of `voice_segments`.
 * @returns The segment, or undefined when a field is missing or not a number.
 */
function segmentOf(raw: unknown): VoiceSegment | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const lineIndex = Reflect.get(raw, "dialogue_input_index");
  const startSeconds = Reflect.get(raw, "start_time_seconds");
  const endSeconds = Reflect.get(raw, "end_time_seconds");
  const isComplete =
    Number.isInteger(lineIndex) && isFiniteNumber(startSeconds) && isFiniteNumber(endSeconds);
  return isComplete ? { lineIndex: Number(lineIndex), startSeconds, endSeconds } : undefined;
}

/**
 * Reads the dialogue response: `audio_base64` (a string) and
 * `voice_segments` (an array of complete segments).
 *
 * @param json - The parsed body, or undefined when it was not JSON.
 * @returns The decoded audio and the segments.
 * @throws {RetryableProviderError} Status 502 when the body is not JSON or lacks either field.
 * @example
 * ```ts
 * readDialogueResponse({
 *   audio_base64: "SUQz",
 *   voice_segments: [{ dialogue_input_index: 0, start_time_seconds: 0.1, end_time_seconds: 1 }]
 * });
 * // => { audio: Uint8Array [73, 68, 51], segments: [{ lineIndex: 0, startSeconds: 0.1, endSeconds: 1 }] }
 * ```
 */
export function readDialogueResponse(json: unknown): DialogueResponse {
  const unreadable = new RetryableProviderError(
    "[ai] ElevenLabs returned an unreadable dialogue response.",
    { status: BAD_GATEWAY }
  );
  if (typeof json !== "object" || json === null) throw unreadable;

  const audioBase64 = Reflect.get(json, "audio_base64");
  const rawSegments: unknown = Reflect.get(json, "voice_segments");
  if (typeof audioBase64 !== "string" || !Array.isArray(rawSegments)) throw unreadable;

  const segments: VoiceSegment[] = [];
  for (const raw of rawSegments) {
    const segment = segmentOf(raw);
    if (segment === undefined) throw unreadable;
    segments.push(segment);
  }
  return { audio: new Uint8Array(Buffer.from(audioBase64, "base64")), segments };
}
