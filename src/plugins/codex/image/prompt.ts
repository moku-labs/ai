/**
 * @file codex image prompt builder — pure. Turns an `ImageRequest` brief
 * into the instruction text codex receives after `--`.
 */

/** Inputs for {@link buildImagePrompt}. */
export type ImagePromptInput = {
  /** What to draw (the request prompt, style already appended). */
  prompt: string;
  /** Things to avoid. */
  negative?: string | undefined;
  /** Aspect ratio, e.g. "9:16". */
  aspect?: string | undefined;
  /** File names of the attached references, e.g. ["ref-1.png"]. */
  refNames: string[];
};

/** Size line per supported aspect ratio. */
const SIZE_LINES: Record<string, string> = {
  "9:16": "Portrait, 1024x1536.",
  "16:9": "Landscape, 1536x1024.",
  "1:1": "Square, 1024x1024."
};

/** Size line used for a missing or unsupported aspect (9:16). */
const DEFAULT_SIZE_LINE = "Portrait, 1024x1536.";

/** First line: ask for exactly one image through the image tool. */
const INSTRUCTION_LINE = "Generate exactly one image with your image generation tool.";

/** Last line: where to save, and to answer with the file name only. */
const SAVE_LINE =
  "Save the image as output.png in the current working directory. Do not write any other files. Reply with the file name only.";

/**
 * Trims whitespace and trailing periods, so the avoid line ends with one.
 *
 * @param text - Negative prompt text.
 * @returns The text without trailing periods.
 * @example
 * ```ts
 * withoutTrailingPeriods("text, logos. "); // => "text, logos"
 * ```
 */
function withoutTrailingPeriods(text: string): string {
  let result = text.trim();
  while (result.endsWith(".")) result = result.slice(0, -1).trimEnd();
  return result;
}

/**
 * Size line for an aspect ratio; unknown or missing aspects get portrait.
 *
 * @param aspect - Aspect ratio, e.g. "16:9".
 * @returns The size line, e.g. "Landscape, 1536x1024.".
 * @example
 * ```ts
 * sizeLineFor("1:1"); // => "Square, 1024x1024."
 * ```
 */
export function sizeLineFor(aspect: string | undefined): string {
  if (aspect === undefined) return DEFAULT_SIZE_LINE;
  return SIZE_LINES[aspect] ?? DEFAULT_SIZE_LINE;
}

/**
 * Builds the codex prompt: instruction, brief, optional avoid line, size,
 * optional reference line, save line — one per line.
 *
 * @param input - Brief, negative, aspect and reference file names.
 * @returns The full prompt text.
 * @example
 * ```ts
 * buildImagePrompt({ prompt: "a patisserie at night", aspect: "9:16", refNames: [] });
 * ```
 */
export function buildImagePrompt(input: ImagePromptInput): string {
  const lines = [INSTRUCTION_LINE, input.prompt];

  const negative = withoutTrailingPeriods(input.negative ?? "");
  if (negative !== "") lines.push(`Avoid: ${negative}.`);
  lines.push(sizeLineFor(input.aspect));
  if (input.refNames.length > 0) {
    lines.push(
      `Use the attached reference images (${input.refNames.join(", ")}) for the look of characters and places; do not copy them verbatim.`
    );
  }
  lines.push(SAVE_LINE);

  return lines.join("\n");
}
