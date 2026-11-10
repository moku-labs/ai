/**
 * @file elevenlabs dialogue — request check, shared by `estimate` and
 * `execute`, before any HTTP call: lines, characters, voices, line ids and
 * the output format. Every refusal is a terminal 400 with a two-line `[ai]`
 * message, so `moku estimate` shows it before any spend.
 */
import type { DialogueRequest } from "../../dialogue/contract";
import { TerminalProviderError } from "../errors";
import type { OutputFormat } from "../formats";
import { resolveOutputFormat } from "../formats";

/** Status of a request refused before any charge. */
const BAD_REQUEST = 400;

/** The most distinct voices one ElevenLabs dialogue request takes. */
const MAX_VOICES = 10;

/** The line keys the dialogue endpoint takes; any other key is not sent. */
const LINE_KEYS: ReadonlySet<string> = new Set(["id", "text", "voice"]);

/** A line id that is a single file name: no slash, no backslash. */
const SAFE_LINE_ID = /^[^/\\]+$/;

/**
 * What the check learned about a valid request.
 *
 * @example
 * ```ts
 * const checked: CheckedDialogue = {
 *   characters: 52,
 *   voices: 2,
 *   ignoredKeys: ["settings"],
 *   format: { code: "mp3_44100_128", mimeType: "audio/mpeg" }
 * };
 * ```
 */
export type CheckedDialogue = {
  /** Characters over every line's text. */
  characters: number;
  /** Distinct voices. */
  voices: number;
  /** Line keys that are not sent (sorted, once each), e.g. `settings` merged from a `$cast`. */
  ignoredKeys: string[];
  /** The resolved output format (`mp3_*` or `wav_*`). */
  format: OutputFormat;
};

/**
 * Builds the terminal 400 of a refused dialogue request.
 *
 * @param problem - The first line, without the `[ai] ` prefix and the period.
 * @param fix - The second line, without the indent and the period.
 * @returns The terminal error.
 */
function refusal(problem: string, fix: string): TerminalProviderError {
  return new TerminalProviderError(`[ai] ${problem}.\n  ${fix}.`, BAD_REQUEST);
}

/**
 * Tells whether `value` is a string with something in it.
 *
 * @param value - A field of a line, from an untrusted build file.
 * @returns True for a non-empty string.
 */
function isFilled(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/**
 * Checks one line id: a single file name, not `.` or `..`, not used before.
 *
 * @param id - The line's id.
 * @param position - The line's 1-based position, for the message.
 * @param seen - Ids of the earlier lines; this id is added.
 * @throws {TerminalProviderError} Status 400 for an unsafe or repeated id.
 */
function checkLineId(id: unknown, position: number, seen: Set<string>): void {
  const isSafe = typeof id === "string" && SAFE_LINE_ID.test(id) && id !== "." && id !== "..";
  if (!isSafe) {
    throw refusal(
      `Invalid dialogue line id ${JSON.stringify(id)} (line ${position})`,
      String.raw`Use a file name without "/" or "\", and not "." or ".."`
    );
  }
  if (seen.has(id)) {
    throw refusal(`Duplicate dialogue line id "${id}"`, "Give every line its own id");
  }
  seen.add(id);
}

/**
 * Checks the lines: at least one, each with a text and a voice, safe unique
 * ids. Collects the characters, the voices and the keys that are not sent.
 *
 * @param request - The dialogue request.
 * @returns The character count, the distinct voices and the ignored keys.
 * @throws {TerminalProviderError} Status 400 for a missing line, text, voice or a bad id.
 */
function checkLines(request: DialogueRequest): {
  characters: number;
  voices: Set<string>;
  ignored: Set<string>;
} {
  const lines: unknown = request.lines;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw refusal(
      "Invalid dialogue request: no lines",
      "Give at least one line with a text and a voice"
    );
  }

  let characters = 0;
  const voices = new Set<string>();
  const ignored = new Set<string>();
  const ids = new Set<string>();
  for (const [index, line] of request.lines.entries()) {
    const position = index + 1;
    if (!isFilled(line.text) || !isFilled(line.voice)) {
      throw refusal(
        `Invalid dialogue request: line ${position} has no text or no voice`,
        "Give every line a text and a voice"
      );
    }
    if (line.id !== undefined) checkLineId(line.id, position, ids);
    for (const key of Object.keys(line)) if (!LINE_KEYS.has(key)) ignored.add(key);
    characters += line.text.length;
    voices.add(line.voice);
  }
  return { characters, voices, ignored };
}

/**
 * Checks a dialogue request before any HTTP call.
 *
 * @param request - The dialogue request.
 * @param maxChars - The most characters the request may carry (`config.dialogueMaxChars`).
 * @returns What the check learned (characters, voices, ignored keys, format).
 * @throws {TerminalProviderError} Status 400 for every refusal.
 * @example
 * ```ts
 * checkDialogue({ lines: [{ text: "Hi.", voice: "v1" }] }, 2000);
 * // => { characters: 3, voices: 1, ignoredKeys: [], format: { code: "mp3_44100_128", mimeType: "audio/mpeg" } }
 * ```
 */
export function checkDialogue(request: DialogueRequest, maxChars: number): CheckedDialogue {
  const { characters, voices, ignored } = checkLines(request);
  if (characters > maxChars) {
    throw refusal(
      `The dialogue has ${characters} characters; ElevenLabs takes at most ${maxChars}`,
      "Split the scene into two items, or raise elevenlabs.dialogueMaxChars"
    );
  }
  if (voices.size > MAX_VOICES) {
    throw refusal(
      `The dialogue uses ${voices.size} voices; ElevenLabs takes at most ${MAX_VOICES}`,
      `Split the scene so each part has ${MAX_VOICES} voices or fewer`
    );
  }

  const format = resolveOutputFormat(request.outputFormat);
  const isCuttable = format.code.startsWith("mp3_") || format.code.startsWith("wav_");
  if (!isCuttable) {
    throw refusal(
      `ElevenLabs dialogue cannot cut "${format.code}" audio`,
      "Use an mp3_* or wav_* output format"
    );
  }
  return { characters, voices: voices.size, ignoredKeys: [...ignored].toSorted(), format };
}
