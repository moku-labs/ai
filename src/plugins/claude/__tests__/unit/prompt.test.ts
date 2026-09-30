import { describe, expect, it } from "vitest";
import { buildClaudePrompt } from "../../prompt/prompt";

describe("buildClaudePrompt", () => {
  it("is the request prompt alone without images; a schema never goes in the prompt", () => {
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
});
