import { describe, expect, it } from "vitest";
import { TerminalProviderError } from "../../errors";
import { isV3OrV4, languageCodeOf, resolveOutputFormat } from "../../formats";

describe("resolveOutputFormat", () => {
  it("lets an explicit outputFormat win over the legacy format", () => {
    expect(resolveOutputFormat("mp3_44100_192", "wav")).toEqual({
      code: "mp3_44100_192",
      mimeType: "audio/mpeg"
    });
  });

  it.each([
    ["mp3", "mp3_44100_128", "audio/mpeg"],
    ["wav", "wav_44100", "audio/wav"],
    ["ogg", "opus_48000_128", "audio/ogg"]
  ])("maps the legacy format %s to %s (%s)", (format, code, mimeType) => {
    expect(resolveOutputFormat(undefined, format)).toEqual({ code, mimeType });
  });

  it("defaults to mp3_44100_128 when neither is set", () => {
    expect(resolveOutputFormat(undefined, undefined).code).toBe("mp3_44100_128");
  });

  it("labels raw pcm with its sample rate", () => {
    expect(resolveOutputFormat("pcm_24000", undefined).mimeType).toBe("audio/L16;rate=24000");
  });

  it("refuses an unknown code, and an unknown legacy format, with a terminal 400", () => {
    for (const [outputFormat, format] of [
      ["ogg_44100", undefined],
      [undefined, "flac"],
      ["toString", undefined]
    ] as const) {
      let caught: unknown;
      try {
        resolveOutputFormat(outputFormat, format);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TerminalProviderError);
      expect((caught as TerminalProviderError).status).toBe(400);
      expect((caught as Error).message).toMatch(/^\[ai\] Unknown ElevenLabs output format "/);
    }
  });
});

describe("languageCodeOf", () => {
  it("sends the lowercased primary subtag for a model that takes a language code", () => {
    expect(languageCodeOf("eleven_v4", "en-US")).toBe("en");
    expect(languageCodeOf("eleven_flash_v2_5", "RU")).toBe("ru");
  });

  it("sends nothing for the multilingual v2 / v1 and monolingual models, or without a language", () => {
    expect(languageCodeOf("eleven_multilingual_v2", "ru")).toBeUndefined();
    expect(languageCodeOf("eleven_multilingual_v1", "ru")).toBeUndefined();
    expect(languageCodeOf("eleven_monolingual_v1", "en")).toBeUndefined();
    expect(languageCodeOf("eleven_v4", undefined)).toBeUndefined();
  });
});

describe("isV3OrV4", () => {
  it("matches the v3 and v4 families only", () => {
    expect(isV3OrV4("eleven_v4")).toBe(true);
    expect(isV3OrV4("eleven_v4_turbo")).toBe(true);
    expect(isV3OrV4("eleven_v3_conversational")).toBe(true);
    expect(isV3OrV4("eleven_v40")).toBe(false);
    expect(isV3OrV4("eleven_multilingual_v2")).toBe(false);
  });
});
