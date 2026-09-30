/**
 * @file codex schema answers — pure. The prompt block that asks for a
 * schema answer, and the check that the answer matches. Codex never gets
 * `--output-schema`: it sends the schema as an OpenAI strict `json_schema`,
 * and strict mode rejects what `z.toJSONSchema` makes (`propertyNames`,
 * record maps, optional keys, `$schema`).
 */
import type { ZodType } from "zod";
import { TerminalProviderError } from "../errors";
import { withoutPeriod } from "../message";

/** Line that introduces the response schema in the prompt. */
const SCHEMA_LINE =
  "Answer with one JSON value only, no prose, no code fence. It must match this JSON Schema:";

/** Prefix of every schema-mismatch error. */
const SCHEMA_MISMATCH = "[ai] Codex answer does not match params.responseSchema.";

/** One ```json (or bare ```) fence around the whole answer. */
const FENCE_PATTERN = /^```(?:json)?[^\S\n]*\n([\s\S]*)\n```$/;

/**
 * The prompt block that asks for a schema answer: the answer rule, then the schema.
 *
 * @param schemaText - The schema as compact JSON.
 * @returns The block, to append after the prompt with a blank line.
 * @example
 * ```ts
 * schemaBlock('{"type":"number"}').endsWith('Schema:\n{"type":"number"}'); // => true
 * ```
 */
export function schemaBlock(schemaText: string): string {
  return `${SCHEMA_LINE}\n${schemaText}`;
}

/**
 * Validates a schema answer: strips one surrounding code fence, parses the
 * JSON, and checks it against the validator.
 *
 * @param text - The answer text.
 * @param validator - Validator built from `params.responseSchema`.
 * @returns The validated JSON, re-stringified compactly.
 * @throws {TerminalProviderError} When the answer is not JSON or does not match; never unavailable.
 * @example
 * ```ts
 * parseSchemaAnswer('```json\n{ "score": 7 }\n```', z.fromJSONSchema({ type: "object" })); // => '{"score":7}'
 * ```
 */
export function parseSchemaAnswer(text: string, validator: ZodType): string {
  // Unwrap one code fence, if any
  const trimmed = text.trim();
  const body = FENCE_PATTERN.exec(trimmed)?.[1] ?? trimmed;

  // Parse the JSON
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new TerminalProviderError(`${SCHEMA_MISMATCH}\n  The answer is not valid JSON.`);
  }

  // Check it against the schema, naming the first issue
  const parsed = validator.safeParse(value);
  const issue = parsed.error?.issues[0];
  if (issue !== undefined) {
    const where = issue.path.length === 0 ? "(root)" : issue.path.join(".");
    throw new TerminalProviderError(
      `${SCHEMA_MISMATCH}\n  ${where}: ${withoutPeriod(issue.message)}.`
    );
  }
  return JSON.stringify(value);
}
