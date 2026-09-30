/**
 * @file claude prompt builder — pure. Turns the request prompt and the
 * copied image names into the stdin text claude receives. A response schema
 * is not in the prompt: it goes to `--json-schema` (see `../cli.ts`).
 */

/** Inputs for {@link buildClaudePrompt}. */
export type ClaudePromptInput = {
  /** The request prompt. */
  prompt: string;
  /** File names of the images copied into the call dir, e.g. ["image-1.png"]. */
  imageNames: string[];
};

/** Line that introduces the attached images. */
const IMAGES_LINE = "Attached images, read each with the Read tool before answering:";

/**
 * Builds the stdin prompt: the request prompt; then, with images, a blank
 * line and a line listing them by relative path.
 *
 * @param input - Prompt and image names.
 * @returns The full prompt text.
 * @example
 * ```ts
 * buildClaudePrompt({ prompt: "Score this frame.", imageNames: ["image-1.png"] });
 * // => "Score this frame.\n\nAttached images, read each with the Read tool before answering: ./image-1.png."
 * ```
 */
export function buildClaudePrompt(input: ClaudePromptInput): string {
  if (input.imageNames.length === 0) return input.prompt;

  const paths = input.imageNames.map(name => `./${name}`).join(", ");
  return `${input.prompt}\n\n${IMAGES_LINE} ${paths}.`;
}
