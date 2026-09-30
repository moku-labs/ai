import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readImages,
  readPromptParameters,
  readReasoning,
  readResponseSchema
} from "../../prompt/params";

const IMAGES_ERROR =
  "[ai] Codex params.images must be image files.\n  Pass { path, mimeType, hash } for every image.";
const SCHEMA_ERROR =
  "[ai] Codex params.responseSchema must be a JSON schema object.\n  Pass the schema as a plain object.";

describe("readImages", () => {
  const image = { path: "/store/aa", mimeType: "image/png", hash: "sha256:aa" };

  it("returns no images when the param is absent", () => {
    expect(readImages(undefined)).toEqual([]);
  });

  it("wraps a single image file in a list", () => {
    expect(readImages(image)).toEqual([image]);
  });

  it("keeps a list of image files in order", () => {
    const second = { path: "/store/bb", mimeType: "image/jpeg", hash: "sha256:bb" };

    expect(readImages([image, second])).toEqual([image, second]);
  });

  it.each([
    ["a string", "/store/aa"],
    ["a file without hash", { path: "/store/aa", mimeType: "image/png" }],
    ["a list with a bad entry", [image, { path: 3, mimeType: "image/png", hash: "h" }]],
    // eslint-disable-next-line unicorn/no-null -- JSON null is a real bad input from a buildfile
    ["null", null]
  ])("throws the pinned error for %s", (_label, value) => {
    expect(() => readImages(value)).toThrow(IMAGES_ERROR);
  });
});

describe("readResponseSchema", () => {
  it("returns undefined when the param is absent", () => {
    expect(readResponseSchema(undefined)).toBeUndefined();
  });

  it("returns the schema as compact JSON text and a validator", () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

    const read = readResponseSchema(schema);

    expect(read?.text).toBe(JSON.stringify(schema));
    expect(read?.validator.safeParse({ ok: true }).success).toBe(true);
    expect(read?.validator.safeParse({ ok: "yes" }).success).toBe(false);
  });

  it("reads the studio storyboard.line schema OpenAI strict mode rejects", () => {
    const file = path.join(import.meta.dirname, "data", "line-schema.json");
    const schema: unknown = JSON.parse(readFileSync(file, "utf8"));

    const read = readResponseSchema(schema);

    expect(read?.validator.safeParse({ add: {}, change: [], questions: [] }).success).toBe(true);
    expect(
      read?.validator.safeParse({ add: { scenes: { bad: {} } }, change: [], questions: [] }).success
    ).toBe(false);
  });

  it("throws the pinned error when zod cannot read the schema", () => {
    expect(() => readResponseSchema({ type: "no-such-type" })).toThrow(SCHEMA_ERROR);
  });

  it.each([
    ["an array", [{ type: "object" }]],
    ["a string", '{"type":"object"}'],
    // eslint-disable-next-line unicorn/no-null -- JSON null is a real bad input from a buildfile
    ["null", null]
  ])("throws the pinned error for %s", (_label, value) => {
    expect(() => readResponseSchema(value)).toThrow(SCHEMA_ERROR);
  });
});

describe("readReasoning", () => {
  it("uses the configured effort when the param is absent", () => {
    expect(readReasoning(undefined, "medium")).toBe("medium");
  });

  it("maps off to low, codex has no off", () => {
    expect(readReasoning("off", "high")).toBe("low");
  });

  it.each(["low", "medium", "high"])("passes %s through", effort => {
    expect(readReasoning(effort, "low")).toBe(effort);
  });

  it.each([
    ["extreme", 'Got "extreme".'],
    [3, 'Got "3".']
  ])("throws the pinned error for %s", (value, got) => {
    expect(() => readReasoning(value, "low")).toThrow(
      `[ai] Codex params.reasoning must be off, low, medium or high.\n  ${got}`
    );
  });
});

describe("readPromptParameters", () => {
  it("reads every param and notes temperature as ignored", () => {
    const params = readPromptParameters(
      { prompt: "p", temperature: 0.2, params: { reasoning: "high", responseSchema: {} } },
      "low"
    );

    expect(params).toEqual({
      images: [],
      schema: { text: "{}", validator: expect.anything() },
      reasoningEffort: "high",
      ignored: ["temperature"]
    });
  });

  it("gives defaults when the request has no params", () => {
    expect(readPromptParameters({ prompt: "p" }, "low")).toEqual({
      images: [],
      schema: undefined,
      reasoningEffort: "low",
      ignored: []
    });
  });
});
