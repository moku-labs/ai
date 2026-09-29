import { describe, expect, it } from "vitest";
import { buildClaudePrompt } from "../../prompt/prompt";

describe("buildClaudePrompt", () => {
  it("is the request prompt alone without images or schema", () => {
    expect(buildClaudePrompt({ prompt: "Say ok.", imageNames: [] })).toBe("Say ok.");
  });

  it("lists the attached images by relative path, to be read with the Read tool", () => {
    const prompt = buildClaudePrompt({
      prompt: "Score this frame.",
      imageNames: ["image-1.png", "image-2.jpg"]
    });

    expect(prompt).toBe(
      "Score this frame.\n\nAttached images, read each with the Read tool before answering: ./image-1.png, ./image-2.jpg."
    );
  });

  it("appends the schema block last, after the image line", () => {
    const schemaText = JSON.stringify({ type: "object" }, undefined, 2);

    const prompt = buildClaudePrompt({
      prompt: "Score this frame.",
      imageNames: ["image-1.png"],
      schemaText
    });

    const blocks = prompt.split("\n\n");
    expect(blocks).toHaveLength(3);
    expect(blocks[2]).toBe(
      `Answer with one JSON value only, no prose, no code fence. It must match this JSON Schema:\n${schemaText}`
    );
  });
});
