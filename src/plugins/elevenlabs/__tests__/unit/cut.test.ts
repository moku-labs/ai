import { describe, expect, it } from "vitest";
import { classifyError, isRetryableErrorClass } from "../../../runner/retry";
import { cutDialogue, planCutWindows } from "../../dialogue/cut";
import { openMp3 } from "../../dialogue/mp3";
import type { VoiceSegment } from "../../dialogue/types";
import { openWav } from "../../dialogue/wav";
import { LocalFailureError } from "../../errors";
import {
  concatBytes,
  FRAME_SECONDS,
  mp3Frame,
  syntheticMp3,
  syntheticWav
} from "../audio-fixtures";

/** A voice segment of line `lineIndex`. */
function segment(lineIndex: number, startSeconds: number, endSeconds: number): VoiceSegment {
  return { lineIndex, startSeconds, endSeconds };
}

describe("cutDialogue — mp3", () => {
  // Line 1 starts exactly on frame 40; line 0 ends 0.05 s before it.
  const nextStart = 40 * FRAME_SECONDS;
  const segments = [
    segment(0, 0.02, 0.5),
    segment(0, 0.6, nextStart - 0.05),
    segment(1, nextStart, 2),
    segment(3, 2.1, 2.6),
    segment(4, 3, 3.5)
  ];

  it("ends a line at the next line's speech start, not +0.150 (the spike's bug), and starts the first line at 0", () => {
    const mp3 = syntheticMp3(200);

    const { cuts } = cutDialogue(mp3.bytes, "mp3_44100_128", segments, 5);

    const first = cuts.find(cut => cut.index === 0);
    expect(first?.piece.bytes).toEqual(concatBytes(mp3.frames.slice(0, 40)));
    expect(first?.piece.startSeconds).toBe(0);
    expect(first?.piece.endSeconds).toBeCloseTo(nextStart, 9);
  });

  it("cuts an unclamped line from floor-frame(start − 0.050) to ceil-frame(end + 0.150)", () => {
    const mp3 = syntheticMp3(200);

    const { cuts } = cutDialogue(mp3.bytes, "mp3_44100_128", segments, 5);

    // 2.95 s → frame 112 (floor of 112.9); 3.65 s → frame 140 (ceil of 139.7).
    const last = cuts.find(cut => cut.index === 4);
    expect(last?.piece.bytes).toEqual(concatBytes(mp3.frames.slice(112, 140)));
  });

  it("omits a line with no segments, lists it, and clamps its neighbours to each other across the gap", () => {
    const mp3 = syntheticMp3(200);

    const { cuts, missing } = cutDialogue(mp3.bytes, "mp3_44100_128", segments, 5);

    expect(missing).toEqual([2]);
    expect(cuts.map(cut => cut.index)).toEqual([0, 1, 3, 4]);
    // Line 1 is clamped by line 3's start (2.1 s), not its own end + 0.150 (frame 83).
    expect(cuts[1]?.piece.endSeconds).toBeLessThanOrEqual(2.1);
  });

  it("rounds a clamped edge inward: no frame that overlaps a neighbour's speech is included", () => {
    const mp3 = syntheticMp3(200);

    const { cuts } = cutDialogue(mp3.bytes, "mp3_44100_128", segments, 5);

    // Line 3 starts at 2.1 s, inside frame 80 (2.0898–2.1159 s): line 1 ends at frame 80, exclusive.
    // Line 0 ends at 0.9949 s, inside frame 38: line 1 starts at frame 39.
    expect(cuts[1]?.piece.bytes).toEqual(concatBytes(mp3.frames.slice(39, 80)));
    expect(cuts[1]?.piece.endSeconds).toBeCloseTo(80 * FRAME_SECONDS, 9);
  });

  it("falls back to the raw speech span when inward rounding leaves no whole frame", () => {
    const mp3 = syntheticMp3(200);
    const tight = [segment(0, 0, 1), segment(1, 1.01, 1.02), segment(2, 1.03, 2)];

    const { cuts } = cutDialogue(mp3.bytes, "mp3_44100_128", tight, 3);

    // Window [1.0, 1.03] holds no whole frame; the raw span 1.01–1.02 s rounds out to frames 38–39.
    expect(cuts[1]?.piece.bytes).toEqual(concatBytes(mp3.frames.slice(38, 40)));
  });

  it("skips an ID3v2 tag and a Xing frame: neither is timed nor cut", () => {
    const mp3 = syntheticMp3(100, { xing: true, id3: 300 });

    const audio = openMp3(mp3.bytes);

    expect(audio?.durationSeconds).toBeCloseTo(100 * FRAME_SECONDS, 9);
    expect(audio?.cut(0, 3 * FRAME_SECONDS).bytes).toEqual(concatBytes(mp3.frames.slice(0, 3)));
  });
});

describe("cutDialogue — wav", () => {
  it("cuts sample-exact with a fresh 44-byte header, clamped to the audio's end", () => {
    const wav = syntheticWav(1000, 5000);

    const { cuts } = cutDialogue(wav, "wav_44100", [segment(0, 1, 2), segment(1, 4.9, 4.95)], 2);

    const [first, last] = cuts;
    const header = new DataView(first?.piece.bytes.buffer ?? new ArrayBuffer(0));
    expect(first?.piece.bytes.length).toBe(44 + 1200 * 2);
    expect(String.fromCodePoint(...(first?.piece.bytes.subarray(0, 4) ?? []))).toBe("RIFF");
    expect(header.getUint32(4, true)).toBe(36 + 1200 * 2);
    expect(header.getUint32(24, true)).toBe(1000);
    expect(String.fromCodePoint(...(first?.piece.bytes.subarray(36, 40) ?? []))).toBe("data");
    expect(header.getUint32(40, true)).toBe(1200 * 2);
    // Samples 950 (0.95 s) .. 2149 (2.15 s, exclusive end 2150): sample k holds the value k.
    expect(header.getUint16(44, true)).toBe(950);
    expect(header.getUint16(44 + 1199 * 2, true)).toBe(2149);
    expect(last?.piece.endSeconds).toBe(5);
    expect(last?.piece.startSeconds).toBeCloseTo(4.85, 9);
  });

  it("rounds a clamped wav edge inward to whole samples", () => {
    const wav = syntheticWav(1000, 5000);

    // Line 1 starts at 2.0005 s, between samples 2000 and 2001: line 0 ends at sample 2000, exclusive.
    const { cuts } = cutDialogue(wav, "wav_44100", [segment(0, 1, 1.9), segment(1, 2.0005, 3)], 2);

    expect(cuts[0]?.piece.endSeconds).toBe(2);
  });

  it("reads the duration as data bytes / (sample rate × block align)", () => {
    expect(openWav(syntheticWav(1000, 2500))?.durationSeconds).toBe(2.5);
  });
});

describe("cutDialogue — free edges never cross a neighbour", () => {
  it("ends a free edge before the next line when it starts within one frame after the tail", () => {
    // Tail 1.15 s rounds up to frame 45 (1.1755 s), past line 1's start at 1.16 s.
    const { cuts } = cutDialogue(
      syntheticMp3(200).bytes,
      "mp3_44100_128",
      [segment(0, 0.2, 1), segment(1, 1.16, 2)],
      2
    );

    expect(cuts[0]?.piece.endSeconds).toBeLessThanOrEqual(1.16);
  });

  it("starts a free edge after the previous line when it ends within one frame before the lead", () => {
    // Lead 1.01 s rounds down to frame 38 (0.9927 s), before line 0's end at 1.0 s.
    const { cuts } = cutDialogue(
      syntheticMp3(200).bytes,
      "mp3_44100_128",
      [segment(0, 0.2, 1), segment(1, 1.06, 2)],
      2
    );

    expect(cuts[1]?.piece.startSeconds).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ["mp3", syntheticMp3(200).bytes, "mp3_44100_128"],
    ["wav", syntheticWav(1000, 5000), "wav_44100"]
  ])("keeps every %s cut off every other line's speech over a sweep of gaps", (_, audio, format) => {
    for (let step = 0; step <= 60; step += 1) {
      const gap = step * 0.0045;
      const spans = [
        [0.2, 1],
        [1 + gap, 2],
        [2 + 2 * gap, 3]
      ] as const;
      const segments = spans.map(([start, end], index) => segment(index, start, end));

      const { cuts } = cutDialogue(audio, format, segments, 3);

      for (const cut of cuts) {
        for (const [index, [start, end]] of spans.entries()) {
          if (index === cut.index) continue;
          const overlaps =
            cut.piece.startSeconds < end - 1e-9 && cut.piece.endSeconds > start + 1e-9;
          expect(overlaps, `gap ${gap}: line ${cut.index} overlaps line ${index}`).toBe(false);
        }
      }
    }
  });
});

describe("openMp3 — stream consistency", () => {
  it("skips a frame whose sample rate differs from the first audio frame's", () => {
    const good = syntheticMp3(10);
    const odd = mp3Frame(7, false);
    odd.set([0xff, 0xfb, 0x94, 0x00]); // MPEG-1 Layer III 128 kbps at 48 kHz: 384 bytes
    const junk = odd.subarray(0, 384);
    const bytes = concatBytes([...good.frames.slice(0, 5), junk, ...good.frames.slice(5)]);

    const audio = openMp3(bytes);

    expect(audio?.durationSeconds).toBeCloseTo(10 * FRAME_SECONDS, 9);
    expect(audio?.cut(0, 10 * FRAME_SECONDS).bytes).toEqual(concatBytes(good.frames));
  });
});

describe("openWav — malformed and extensible headers", () => {
  it("treats a fmt chunk cut short by the end of the file as unreadable, not a RangeError", () => {
    const truncated = syntheticWav(1000, 10).subarray(0, 28);

    expect(() => cutDialogue(truncated, "wav_44100", [segment(0, 0, 0.005)], 1)).toThrow(
      LocalFailureError
    );
  });

  it("writes the PCM sub-format code into the header of a cut from WAVE_FORMAT_EXTENSIBLE audio", () => {
    const audio = openWav(syntheticWav(1000, 3000, { extensible: true }));

    const piece = audio?.cut(1, 2);

    expect(audio?.durationSeconds).toBe(3);
    expect(new DataView(piece?.bytes.buffer ?? new ArrayBuffer(0)).getUint16(20, true)).toBe(1);
  });
});

describe("planCutWindows", () => {
  it("uses the raw speech span when the clamp leaves nothing (overlapping speech)", () => {
    const { windows } = planCutWindows([segment(0, 1, 3), segment(1, 1.5, 2.5)], 2, 10);

    expect(windows[1]).toMatchObject({ index: 1, from: 1.5, to: 2.5 });
    expect(windows[1]?.hard).toEqual({ from: 0, to: 10 });
  });
});

describe("cutDialogue — unreadable audio", () => {
  it.each([
    "mp3_44100_128",
    "wav_44100"
  ])("throws a one-attempt local-failure for %s audio with no frames or data", format => {
    let caught: unknown;
    try {
      cutDialogue(new Uint8Array([1, 2, 3, 4, 5]), format, [segment(0, 0, 1)], 1);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LocalFailureError);
    expect((caught as LocalFailureError).publicMessage).toBe(
      "[ai] Could not cut the ElevenLabs dialogue audio.\n  The response audio has no readable mp3 frames or wav data."
    );
    expect(classifyError(caught)).toBe("local-failure");
    expect(isRetryableErrorClass(classifyError(caught))).toBe(false);
  });
});
