import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TerminalProviderError } from "../../errors";
import { parseSchemaAnswer, schemaBlock } from "../../prompt/answer";

const MISMATCH = "[ai] Codex answer does not match params.responseSchema.";

describe("schemaBlock", () => {
  it("gives the answer rule, a newline, then the schema text", () => {
    expect(schemaBlock('{"type":"number"}')).toBe(
      'Answer with one JSON value only, no prose, no code fence. It must match this JSON Schema:\n{"type":"number"}'
    );
  });
});

describe("parseSchemaAnswer", () => {
  const validator = z.fromJSONSchema({
    type: "object",
    properties: { score: { type: "number" }, tags: { type: "array", items: { type: "string" } } },
    required: ["score"]
  });

  /**
   * The error `parseSchemaAnswer` throws for `text`.
   *
   * @param text - The answer text.
   * @returns The thrown value.
   */
  function errorFor(text: string): unknown {
    try {
      parseSchemaAnswer(text, validator);
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it("re-stringifies a valid answer compactly", () => {
    expect(parseSchemaAnswer('  { "score": 7 }\n', validator)).toBe('{"score":7}');
  });

  it.each([
    ["a json fence", '```json\n{"score":7}\n```'],
    ["a bare fence", '```\n{"score":7}\n```']
  ])("strips %s", (_label, text) => {
    expect(parseSchemaAnswer(text, validator)).toBe('{"score":7}');
  });

  it.each([
    ["prose", "sure, here it is"],
    ["an empty answer", ""]
  ])("throws a terminal error for %s", (_label, text) => {
    const error = errorFor(text);

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toBe(`${MISMATCH}\n  The answer is not valid JSON.`);
  });

  it("names (root) for a mismatch at the root", () => {
    expect((errorFor("[]") as Error).message).toMatch(/^.+\n {2}\(root\): .+\.$/);
  });

  it("names the path for a nested mismatch, ending with one period", () => {
    const message = (errorFor('{"score":1,"tags":["a",2]}') as Error).message;

    expect(message).toMatch(/\n {2}tags\.1: .+[^.]\.$/);
  });
});
