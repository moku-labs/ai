import { describe, expect, it } from "vitest";
import type { MusicChunk, MusicRequest } from "../../../music/contract";
import { TerminalProviderError } from "../../errors";
import { checkMusicRequest, musicAliases } from "../../music/models";

// ─────────────────────────────────────────────────────────────────────────────
// fal music catalog: zod validation, chunk and range rules, body builders.
// ─────────────────────────────────────────────────────────────────────────────

const ELEVEN = "elevenlabs-music-v2.5";
const STABLE = "stable-audio-2.5";

/** A chunk of `durationMs` with one style. */
function chunk(durationMs: number, extra: Partial<MusicChunk> = {}): MusicChunk {
  return { text: "verse", durationMs, styles: ["synthwave"], ...extra };
}

/** The error `checkMusicRequest` throws for `request`. */
function errorOf(request: unknown): unknown {
  try {
    // A runtime shape the type system would refuse: the zod schema is the guard under test.
    checkMusicRequest(request as MusicRequest);
  } catch (error) {
    return error;
  }
  throw new Error("expected checkMusicRequest to throw");
}

describe("catalog", () => {
  it("lists the aliases in catalog order", () => {
    expect(musicAliases()).toEqual([ELEVEN, STABLE]);
  });

  it("rejects an unknown alias with a terminal 400 listing the aliases", () => {
    expect(errorOf({ prompt: "p", model: "suno", lengthMs: 5000 })).toMatchObject({
      name: "TerminalProviderError",
      status: 400,
      message:
        '[ai] Unknown fal music model "suno".\n  Use one of: elevenlabs-music-v2.5, stable-audio-2.5.'
    });
  });
});

describe("validation", () => {
  it.each([
    ["prompt", { prompt: "", model: STABLE, lengthMs: 5000 }],
    ["model", { prompt: "p", model: "", lengthMs: 5000 }],
    ["lengthMs", { prompt: "p", model: STABLE, lengthMs: 1.5 }],
    ["lengthMs", { prompt: "p", model: STABLE, lengthMs: -5 }],
    [
      "chunks.0.styles",
      { prompt: "p", model: ELEVEN, lengthMs: 5000, chunks: [chunk(5000, { styles: [] })] }
    ],
    [
      "chunks.0.text",
      { prompt: "p", model: ELEVEN, lengthMs: 5000, chunks: [chunk(5000, { text: "" })] }
    ],
    ["seed", { prompt: "p", model: STABLE, lengthMs: 5000, seed: 1.5 }],
    ["params", { prompt: "p", model: STABLE, lengthMs: 5000, params: "loud" }]
  ])("names %s in the terminal 400", (field, request) => {
    const error = errorOf(request);
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({ status: 400 });
    const { message } = error as Error;
    expect(message.startsWith(`[ai] Invalid music request: ${field} `)).toBe(true);
    expect(message.endsWith(".\n  Fix the build item that produced it.")).toBe(true);
  });

  it.each([
    [STABLE, 999, "lengthMs must be from 1000 to 190000 for stable-audio-2.5"],
    [STABLE, 190_001, "lengthMs must be from 1000 to 190000 for stable-audio-2.5"],
    [ELEVEN, 2999, "lengthMs must be from 3000 to 600000 for elevenlabs-music-v2.5"],
    [ELEVEN, 600_001, "lengthMs must be from 3000 to 600000 for elevenlabs-music-v2.5"]
  ])("%s refuses %d ms", (model, lengthMs, detail) => {
    expect(errorOf({ prompt: "p", model, lengthMs })).toMatchObject({
      message: `[ai] Invalid music request: ${detail}.\n  Fix the build item that produced it.`
    });
  });

  it("refuses a chunk outside 3000..120000 ms", () => {
    const request = {
      prompt: "p",
      model: ELEVEN,
      lengthMs: 122_000,
      chunks: [chunk(2000), chunk(120_000)]
    };
    expect(errorOf(request)).toMatchObject({
      message: expect.stringContaining("chunks.0.durationMs must be from 3000 to 120000")
    });
  });

  it("refuses more than 30 chunks", () => {
    const chunks = Array.from({ length: 31 }, () => chunk(3000));
    expect(errorOf({ prompt: "p", model: ELEVEN, lengthMs: 93_000, chunks })).toMatchObject({
      message: expect.stringContaining("chunks must be at most 30")
    });
  });

  it("refuses chunks that do not add up to lengthMs", () => {
    const request = {
      prompt: "p",
      model: ELEVEN,
      lengthMs: 60_000,
      chunks: [chunk(20_000), chunk(30_000)]
    };
    expect(errorOf(request)).toMatchObject({
      message: expect.stringContaining("chunks add up to 50000 ms, not 60000")
    });
  });

  it("validates chunks for Stable Audio too, though its body ignores them", () => {
    const request = { prompt: "p", model: STABLE, lengthMs: 10_000, chunks: [chunk(5000)] };
    expect(errorOf(request)).toBeInstanceOf(TerminalProviderError);
  });
});

describe("bodies", () => {
  it("ElevenLabs with chunks sends a composition plan, seed and the output format", () => {
    const request: MusicRequest = {
      prompt: "ignored with a plan",
      model: ELEVEN,
      lengthMs: 45_000,
      seed: 7,
      chunks: [chunk(15_000, { avoid: ["vocals"] }), chunk(30_000, { text: "drop", avoid: [] })],
      params: { loudness: 3 }
    };
    const { model } = checkMusicRequest(request);
    expect(model.endpoint).toBe("fal-ai/elevenlabs/music/v2.5");
    expect(model.body(request)).toEqual({
      composition_plan: {
        chunks: [
          {
            text: "verse",
            duration_ms: 15_000,
            positive_styles: ["synthwave"],
            negative_styles: ["vocals"]
          },
          { text: "drop", duration_ms: 30_000, positive_styles: ["synthwave"] }
        ]
      },
      seed: 7,
      output_format: "mp3_48000_192"
    });
  });

  it("ElevenLabs without chunks sends an instrumental prompt of lengthMs", () => {
    const request: MusicRequest = {
      prompt: "tense synth",
      model: ELEVEN,
      lengthMs: 60_000,
      seed: 3
    };
    expect(checkMusicRequest(request).model.body(request)).toEqual({
      prompt: "tense synth",
      music_length_ms: 60_000,
      force_instrumental: true,
      output_format: "mp3_48000_192"
    });
  });

  it("Stable Audio sends the prompt, whole seconds and the seed; params never reach the body", () => {
    const request: MusicRequest = {
      prompt: "rain",
      model: STABLE,
      lengthMs: 2500,
      seed: 11,
      params: { steps: 100 }
    };
    const { model } = checkMusicRequest(request);
    expect(model.endpoint).toBe("fal-ai/stable-audio-25/text-to-audio");
    expect(model.body(request)).toEqual({ prompt: "rain", seconds_total: 3, seed: 11 });
  });
});
