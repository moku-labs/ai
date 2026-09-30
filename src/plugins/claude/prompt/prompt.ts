/**
 * @file claude prompt builder — pure. Turns the request prompt, the copied
 * image names and, only for a schema `--json-schema` cannot take, the
 * schema text into the stdin text claude receives.
 */

/** Inputs for {@link buildClaudePrompt}. */
export type ClaudePromptInput = {
  /** The request prompt. */
  prompt: string;
  /** File names of the images copied into the call dir, e.g. ["image-1.png"]. */
  imageNames: string[];
  /** The response schema as JSON, only when it cannot go to `--json-schema`. */
  schemaText?: string | undefined;
};

/** Line that introduces the attached images. */
const IMAGES_LINE = "Attached images, read each with the Read tool before answering:";

/** Line that introduces the response schema. */
const SCHEMA_LINE =
  "Answer with one JSON value only, no prose, no code fence. It must match this JSON Schema:";

/**
 * Builds the stdin prompt: the request prompt; then, with images, a line
 * listing them by relative path; then, with a schema text, the answer rule
 * and the schema. Blocks are separated by a blank line.
 *
 * @param input - Prompt, image names and schema text.
 * @returns The full prompt text.
 * @example
 * ```ts
 * buildClaudePrompt({ prompt: "Score this frame.", imageNames: ["image-1.png"] });
 * // => "Score this frame.\n\nAttached images, read each with the Read tool before answering: ./image-1.png."
 * ```
 */
export function buildClaudePrompt(input: ClaudePromptInput): string {
  const blocks = [input.prompt];

  if (input.imageNames.length > 0) {
    const paths = input.imageNames.map(name => `./${name}`).join(", ");
    blocks.push(`${IMAGES_LINE} ${paths}.`);
  }
  if (input.schemaText !== undefined) blocks.push(`${SCHEMA_LINE}\n${input.schemaText}`);

  return blocks.join("\n\n");
}
