import { describe, expect, it } from "vitest";
import { buildImagePrompt, sizeLineFor } from "../../image/prompt";

describe("sizeLineFor", () => {
  it("maps 9:16 to portrait 1024x1536", () => {
    expect(sizeLineFor("9:16")).toBe("Portrait, 1024x1536.");
  });

  it("maps 16:9 to landscape 1536x1024", () => {
    expect(sizeLineFor("16:9")).toBe("Landscape, 1536x1024.");
  });

  it("maps 1:1 to square 1024x1024", () => {
    expect(sizeLineFor("1:1")).toBe("Square, 1024x1024.");
  });

  it("defaults to portrait when aspect is missing or unknown", () => {
    expect(sizeLineFor(undefined)).toBe("Portrait, 1024x1536.");
    expect(sizeLineFor("4:3")).toBe("Portrait, 1024x1536.");
  });
});

describe("buildImagePrompt", () => {
  it("builds the instruction, brief, size and save lines in order", () => {
    const prompt = buildImagePrompt({ prompt: "a patisserie at night", refNames: [] });

    expect(prompt).toBe(
      [
        "Generate exactly one image with your image generation tool.",
        "a patisserie at night",
        "Portrait, 1024x1536.",
        "Save the image as output.png in the current working directory. Do not write any other files. Reply with the file name only."
      ].join("\n")
    );
  });

  it("adds an Avoid line for the negative prompt, without a doubled period", () => {
    const prompt = buildImagePrompt({ prompt: "p", negative: "text, logos.", refNames: [] });

    expect(prompt).toContain("\nAvoid: text, logos.\n");
  });

  it("uses the aspect for the size line", () => {
    const prompt = buildImagePrompt({ prompt: "p", aspect: "16:9", refNames: [] });

    expect(prompt).toContain("Landscape, 1536x1024.");
  });

  it("names the attached references when there are any", () => {
    const prompt = buildImagePrompt({ prompt: "p", refNames: ["ref-1.png", "ref-2.jpg"] });

    expect(prompt).toContain(
      "Use the attached reference images (ref-1.png, ref-2.jpg) for the look of characters and places; do not copy them verbatim."
    );
  });

  it("omits the reference and avoid lines when not needed", () => {
    const prompt = buildImagePrompt({ prompt: "p", refNames: [] });

    expect(prompt).not.toContain("reference");
    expect(prompt).not.toContain("Avoid");
  });
});
