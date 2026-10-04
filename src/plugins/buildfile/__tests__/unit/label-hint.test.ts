import { describe, expect, it } from "vitest";
import { createBuildfileApi } from "../../api";
import { buildItemSchema, firstIssueMessage } from "../../schema";
import type { BuildfileContext } from "../../types";

/** The exact zod message for a bad label hint (no `[ai]` prefix, no period). */
const HINT_MESSAGE = "only a trailing {nine=l,t,r,b} hint with whole-pixel insets is allowed";

/**
 * Builds a mock buildfile context (config + empty state + no-op emit).
 */
function createTestCtx(): BuildfileContext {
  const config = { defaultGlob: "**/*.moku.yaml", schemaPath: ".moku/build.schema.json" };
  return { config, state: {}, emit: () => undefined };
}

/**
 * Parses one sprite item with the given id and returns the first issue text.
 */
function issueFor(id: string): string {
  const result = buildItemSchema.safeParse({ task: "sprite", id, input: {} });
  if (result.success) throw new Error(`expected "${id}" to fail`);
  return firstIssueMessage(result.error);
}

describe("buildfile unit: label hint in item id", () => {
  it("accepts a trailing {nine=l,t,r,b} hint with whole-pixel insets", () => {
    const result = buildItemSchema.safeParse({
      task: "sprite",
      id: "button{nine=12,12,12,12}",
      input: {}
    });
    expect(result.success).toBe(true);
  });

  it("accepts multi-digit and zero insets", () => {
    const result = buildItemSchema.safeParse({
      task: "sprite",
      id: "ui.panel{nine=0,128,7,64}",
      input: {}
    });
    expect(result.success).toBe(true);
  });

  it("leaves ids without braces unchanged", () => {
    const result = buildItemSchema.safeParse({ task: "sprite", id: "s01.key", input: {} });
    expect(result.success).toBe(true);
  });

  it.each([
    ["a malformed hint", "button{nine=12,12,12}"],
    ["an unclosed hint", "button{nine=12,12,12,12"],
    ["a stray closing brace", "button}"],
    ["a non-integer inset", "button{nine=12.5,12,12,12}"],
    ["a negative inset", "button{nine=-1,12,12,12}"],
    ["a brace in the middle", "but{nine=1,2,3,4}ton"],
    ["an unknown key", "button{pad=1,2,3,4}"],
    ["a hint with no label before it", "{nine=1,2,3,4}"],
    ["two hints", "button{nine=1,2,3,4}{nine=1,2,3,4}"]
  ])("rejects %s on path id", (_case, id) => {
    expect(issueFor(id)).toBe(`id: ${HINT_MESSAGE}`);
  });

  it("wraps the issue in the pinned two-line compile error", async () => {
    const api = createBuildfileApi(createTestCtx());
    await expect(
      api.compile({
        text: 'version: 1\nname: x\nitems:\n  - task: sprite\n    id: "button{nine=1.5,2,3,4}"\n    input: {}\n',
        lang: "yaml"
      })
    ).rejects.toThrow(
      new Error(`[ai] Build file "<inline>" is invalid.\n  items.0.id: ${HINT_MESSAGE}.`)
    );
  });
});
