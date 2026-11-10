/**
 * @file elevenlabs output formats and request-field helpers shared by the
 * voiceover and dialogue handlers: the accepted `output_format` codes and
 * their mime types, the legacy `format` map, the `language_code` rule and the
 * v3/v4 model check. Per-task submodules never import each other, so they
 * share these through this root module (spec/10).
 *
 * Tier notes (ElevenLabs TTS reference, checked 2026-11-10): `mp3_44100_192`
 * needs the Creator tier or above; `pcm_44100` and `wav_44100` need the Pro
 * tier or above. A lower tier gets a 4xx from ElevenLabs, a terminal failure.
 */
import { TerminalProviderError } from "./errors";

/** Status of a request refused before any charge. */
const BAD_REQUEST = 400;

/** The code used when a request sets neither `outputFormat` nor `format`. */
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";

/**
 * Every accepted ElevenLabs `output_format` code, with the mime type of the
 * audio it returns. `pcm_*` is raw headerless 16-bit samples (exported as
 * `.bin`); `opus_*` ships in an Ogg container.
 */
export const OUTPUT_FORMATS: Readonly<Record<string, string>> = {
  mp3_22050_32: "audio/mpeg",
  mp3_44100_32: "audio/mpeg",
  mp3_44100_64: "audio/mpeg",
  mp3_44100_96: "audio/mpeg",
  mp3_44100_128: "audio/mpeg",
  mp3_44100_192: "audio/mpeg",
  wav_16000: "audio/wav",
  wav_22050: "audio/wav",
  wav_24000: "audio/wav",
  wav_44100: "audio/wav",
  wav_48000: "audio/wav",
  pcm_16000: "audio/L16;rate=16000",
  pcm_22050: "audio/L16;rate=22050",
  pcm_24000: "audio/L16;rate=24000",
  pcm_44100: "audio/L16;rate=44100",
  pcm_48000: "audio/L16;rate=48000",
  opus_48000_64: "audio/ogg",
  opus_48000_128: "audio/ogg",
  opus_48000_192: "audio/ogg"
};

/** The `output_format` code each legacy `format` value requests. */
const CODE_BY_LEGACY_FORMAT: Readonly<Record<string, string>> = {
  mp3: "mp3_44100_128",
  wav: "wav_44100",
  ogg: "opus_48000_128"
};

/** Models that take no `language_code` ("not supported for multilingual_v2 models"). */
const MODELS_WITHOUT_LANGUAGE_CODE: ReadonlySet<string> = new Set([
  "eleven_multilingual_v2",
  "eleven_multilingual_v1",
  "eleven_monolingual_v1"
]);

/** Matches the v3 and v4 model families (`eleven_v4`, `eleven_v4_turbo`, `eleven_v3_conversational`). */
const V3_OR_V4_MODEL = /^eleven_v[34](?:_|$)/;

/**
 * An ElevenLabs output format: the `output_format` query code and the mime
 * type of the audio it returns.
 *
 * @example
 * ```ts
 * const format: OutputFormat = { code: "wav_44100", mimeType: "audio/wav" };
 * ```
 */
export type OutputFormat = {
  /** The `output_format` query value, e.g. "mp3_44100_192". */
  code: string;
  /** The mime type of the returned audio, e.g. "audio/mpeg". */
  mimeType: string;
};

/**
 * Builds the terminal error for an output format ElevenLabs does not take.
 *
 * @param value - The rejected code.
 * @returns The two-line terminal 400 error listing the accepted codes.
 */
function unknownFormatError(value: string): TerminalProviderError {
  const accepted = Object.keys(OUTPUT_FORMATS).join(", ");
  return new TerminalProviderError(
    `[ai] Unknown ElevenLabs output format "${value}".\n  Use one of: ${accepted}.`,
    BAD_REQUEST
  );
}

/**
 * Resolves the output format of a request: `outputFormat` when set, else the
 * legacy `format` map (`mp3 → mp3_44100_128`, `wav → wav_44100`,
 * `ogg → opus_48000_128`), else `mp3_44100_128`.
 *
 * @param outputFormat - The request's explicit ElevenLabs code, if any.
 * @param format - The request's legacy container format, if any.
 * @returns The code and its mime type.
 * @throws {TerminalProviderError} Status 400 for a code or format not in the table.
 * @example
 * ```ts
 * resolveOutputFormat(undefined, "wav"); // => { code: "wav_44100", mimeType: "audio/wav" }
 * resolveOutputFormat("mp3_44100_192", "wav"); // => { code: "mp3_44100_192", mimeType: "audio/mpeg" }
 * ```
 */
export function resolveOutputFormat(
  outputFormat: string | undefined,
  format?: string
): OutputFormat {
  const legacyCode = format === undefined ? DEFAULT_OUTPUT_FORMAT : CODE_BY_LEGACY_FORMAT[format];
  const code = outputFormat ?? legacyCode;
  if (code === undefined) throw unknownFormatError(format ?? "");

  const mimeType = Object.hasOwn(OUTPUT_FORMATS, code) ? OUTPUT_FORMATS[code] : undefined;
  if (mimeType === undefined) throw unknownFormatError(code);
  return { code, mimeType };
}

/**
 * The `language_code` to send for `model`: the primary subtag of `language`,
 * lowercased, or nothing when no language is given or the model takes none.
 *
 * @param model - The resolved model id.
 * @param language - The request's BCP-47 language tag, if any.
 * @returns The language code, or undefined when none is sent.
 * @example
 * ```ts
 * languageCodeOf("eleven_v4", "en-US"); // => "en"
 * languageCodeOf("eleven_multilingual_v2", "ru"); // => undefined
 * ```
 */
export function languageCodeOf(model: string, language: string | undefined): string | undefined {
  if (language === undefined || MODELS_WITHOUT_LANGUAGE_CODE.has(model)) return undefined;
  const [primary = language] = language.split("-");
  return primary.toLowerCase();
}

/**
 * Tells whether `model` is a v3 or v4 model, which honour only the
 * stability and similarity voice settings.
 *
 * @param model - The resolved model id.
 * @returns True for `eleven_v3*` and `eleven_v4*` models.
 * @example
 * ```ts
 * isV3OrV4("eleven_v4_turbo"); // => true
 * isV3OrV4("eleven_multilingual_v2"); // => false
 * ```
 */
export function isV3OrV4(model: string): boolean {
  return V3_OR_V4_MODEL.test(model);
}
