/**
 * @file Synthetic audio + dialogue-response fixtures for the elevenlabs
 * dialogue tests (unit, plugin integration and the framework journey). Not a
 * test file itself (no `.test.ts` suffix).
 */

/** Seconds of one MPEG-1 Layer III frame at 44.1 kHz. */
export const FRAME_SECONDS = 1152 / 44_100;

/** A synthetic CBR mp3: the whole file and each audio frame on its own. */
export type SyntheticMp3 = { bytes: Uint8Array; frames: Uint8Array[] };

/**
 * One MPEG-1 Layer III 128 kbps 44.1 kHz stereo frame: 417 bytes, 418 with
 * the padding bit. The body is filled with `marker` (never 0xFF).
 */
export function mp3Frame(marker: number, padded: boolean): Uint8Array {
  const frame = new Uint8Array(padded ? 418 : 417).fill(marker);
  frame.set([0xff, 0xfb, padded ? 0x92 : 0x90, 0x00]);
  return frame;
}

/** A Xing header frame (same layout as an audio frame, "Xing" after the 32-byte side info). */
function xingFrame(): Uint8Array {
  const frame = mp3Frame(0, false);
  frame.set([0x58, 0x69, 0x6e, 0x67], 36);
  return frame;
}

/** An ID3v2.4 tag of `size` body bytes. */
function id3Tag(size: number): Uint8Array {
  const tag = new Uint8Array(10 + size);
  tag.set([
    0x49,
    0x44,
    0x33,
    4,
    0,
    0,
    (size >> 21) & 0x7f,
    (size >> 14) & 0x7f,
    (size >> 7) & 0x7f,
    size & 0x7f
  ]);
  return tag;
}

/** Concatenates byte chunks. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * A CBR mp3 of `count` audio frames; frame k carries marker `k % 200 + 1`
 * and the padding bit on every third frame (real encoders mix 417/418).
 */
export function syntheticMp3(
  count: number,
  extras: { xing?: boolean; id3?: number } = {}
): SyntheticMp3 {
  const frames = Array.from({ length: count }, (_, index) =>
    mp3Frame((index % 200) + 1, index % 3 === 0)
  );
  const prefix = [
    ...(extras.id3 === undefined ? [] : [id3Tag(extras.id3)]),
    ...(extras.xing ? [xingFrame()] : [])
  ];
  return { bytes: concatBytes([...prefix, ...frames]), frames };
}

/** A mono 16-bit PCM wav at `sampleRate` with `frames` samples (sample k = k), a LIST chunk before data. */
export function syntheticWav(sampleRate: number, frames: number): Uint8Array {
  const list = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 4, 0, 0, 0, 0x49, 0x4e, 0x46, 0x4f]);
  const header = new Uint8Array(36);
  const view = new DataView(header.buffer);
  header.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 36 + list.length + 8 + frames * 2 - 8, true);
  header.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  const dataHeader = new Uint8Array(8);
  dataHeader.set([0x64, 0x61, 0x74, 0x61], 0);
  new DataView(dataHeader.buffer).setUint32(4, frames * 2, true);
  const data = new Uint8Array(frames * 2);
  const dataView = new DataView(data.buffer);
  for (let index = 0; index < frames; index += 1)
    dataView.setUint16(index * 2, index % 65_536, true);
  return concatBytes([header, list, dataHeader, data]);
}

/** One `voice_segments` entry of a dialogue response. */
export type WireSegment = {
  dialogue_input_index: number;
  start_time_seconds: number;
  end_time_seconds: number;
};

/** A `/v1/text-to-dialogue/with-timestamps` JSON body. */
export function dialogueBody(audio: Uint8Array, segments: WireSegment[]): Record<string, unknown> {
  return {
    audio_base64: Buffer.from(audio).toString("base64"),
    voice_segments: segments.map(segment => ({ voice_id: "v", ...segment }))
  };
}

/** A successful JSON `Response` (partial mock of the Fetch API type, spec/09 R9 allowlist). */
export function fakeJsonResponse(body: unknown, status = 200): Response {
  const fake = {
    ok: status < 400,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0))
  };
  return fake as unknown as Response;
}
