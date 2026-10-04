import { describe, expect, it } from "vitest";
import type { SfxRequest } from "../../../sfx/contract";
import { TerminalProviderError } from "../../errors";
import { mergePrices } from "../../prices";
import { checkSfxRequest, sfxAliases, sfxModels } from "../../sfx/models";
import { sfxPriceOf, sfxPrices, sfxRate } from "../../sfx/prices";

// ─────────────────────────────────────────────────────────────────────────────
// fal sfx catalog: zod validation, the duration range, the mp3 body, prices.
// ─────────────────────────────────────────────────────────────────────────────

const ALIAS = "elevenlabs-sfx-v2";

/** The error `checkSfxRequest` throws for `request`. */
function errorOf(request: unknown): unknown {
  try {
    // A runtime shape the type system would refuse: the zod schema is the guard under test.
    checkSfxRequest(request as SfxRequest);
  } catch (error) {
    return error;
  }
  throw new Error("expected checkSfxRequest to throw");
}

describe("catalog", () => {
  it("lists the one alias and maps it to the fal ElevenLabs SFX v2 endpoint", () => {
    expect(sfxAliases()).toEqual([ALIAS]);
    expect(sfxModels[ALIAS]).toMatchObject({
      endpoint: "fal-ai/elevenlabs/sound-effects/v2",
      minMs: 500,
      maxMs: 22_000
    });
  });

  it("rejects an unknown alias with a terminal 400 listing the aliases", () => {
    expect(errorOf({ prompt: "coin", model: "eleven_text_to_sound_v2" })).toMatchObject({
      name: "TerminalProviderError",
      status: 400,
      message:
        '[ai] Unknown fal sfx model "eleven_text_to_sound_v2".\n  Use one of: elevenlabs-sfx-v2.'
    });
  });
});

describe("validation", () => {
  it.each([
    ["prompt", { prompt: "", model: ALIAS }],
    ["prompt", { prompt: "x".repeat(451), model: ALIAS }],
    ["model", { prompt: "coin", model: "" }],
    ["durationMs", { prompt: "coin", model: ALIAS, durationMs: "600" }],
    ["promptInfluence", { prompt: "coin", model: ALIAS, promptInfluence: 1.5 }],
    ["promptInfluence", { prompt: "coin", model: ALIAS, promptInfluence: -0.1 }],
    ["loop", { prompt: "coin", model: ALIAS, loop: "yes" }],
    ["params", { prompt: "coin", model: ALIAS, params: "loud" }]
  ])("names %s in the terminal 400", (field, request) => {
    const error = errorOf(request);
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({ status: 400 });
    const { message } = error as Error;
    expect(message.startsWith(`[ai] Invalid sfx request: ${field} `)).toBe(true);
    expect(message.endsWith(".\n  Fix the build item that produced it.")).toBe(true);
  });

  it("accepts a 450-character prompt", () => {
    expect(checkSfxRequest({ prompt: "x".repeat(450), model: ALIAS }).model.alias).toBe(ALIAS);
  });

  it.each([499, 22_001])("refuses %d ms", durationMs => {
    expect(errorOf({ prompt: "coin", model: ALIAS, durationMs })).toMatchObject({
      status: 400,
      message:
        "[ai] Invalid sfx request: durationMs must be from 500 to 22000 for elevenlabs-sfx-v2.\n  Fix the build item that produced it."
    });
  });

  it.each([500, 22_000])("accepts %d ms", durationMs => {
    expect(checkSfxRequest({ prompt: "coin", model: ALIAS, durationMs }).request.durationMs).toBe(
      durationMs
    );
  });
});

describe("body", () => {
  it("maps every field and always asks for mp3", () => {
    const { model, request } = checkSfxRequest({
      prompt: "coin pickup",
      model: ALIAS,
      durationMs: 600,
      promptInfluence: 0.4,
      loop: true,
      params: { output_format: "pcm_44100" }
    });
    expect(model.body(request)).toEqual({
      text: "coin pickup",
      duration_seconds: 0.6,
      prompt_influence: 0.4,
      loop: true,
      output_format: "mp3_44100_128"
    });
  });

  it("sends only text and the mp3 format when nothing else is set", () => {
    const { model, request } = checkSfxRequest({ prompt: "sword hit", model: ALIAS });
    expect(model.body(request)).toEqual({ text: "sword hit", output_format: "mp3_44100_128" });
  });
});

describe("prices", () => {
  it("bundles $0.002 per second, merged under sfx:", () => {
    expect(sfxPrices[ALIAS]).toBe(0.002);
    expect(mergePrices({})[`sfx:${ALIAS}`]).toBe(0.002);
    expect(sfxRate(mergePrices({}), ALIAS)).toBe(0.002);
  });

  it.each([
    [500, 0.002],
    [1000, 0.002],
    [1001, 0.004],
    [2500, 0.006],
    [22_000, 0.044]
  ])("bills %d ms per started second as $%d", (durationMs, usd) => {
    expect(sfxPriceOf(mergePrices({}), ALIAS, durationMs)).toBe(usd);
  });

  it("takes an override and throws a terminal 400 for a missing row", () => {
    expect(sfxPriceOf(mergePrices({ [`sfx:${ALIAS}`]: 0.01 }), ALIAS, 3000)).toBe(0.03);
    expect(() => sfxRate({}, ALIAS)).toThrow(
      '[ai] No price for fal sfx model "elevenlabs-sfx-v2".\n  Add it to fal.priceOverrides.'
    );
  });
});
