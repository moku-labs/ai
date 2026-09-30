import { describe, expect, it } from "vitest";
import { readParameters } from "../../prompt/params";

const IMAGE = { path: "/store/frame.png", mimeType: "image/png", hash: "sha256:ab12" };

describe("readParameters", () => {
  it("returns no images, schema or reasoning when params is absent", () => {
    expect(readParameters(undefined)).toEqual({
      images: [],
      schema: undefined,
      reasoning: undefined
    });
  });

  it("accepts one image file or an array of them, ignoring other params", () => {
    expect(readParameters({ images: IMAGE, seed: 3 }).images).toEqual([IMAGE]);
    expect(readParameters({ images: [IMAGE, IMAGE] }).images).toEqual([IMAGE, IMAGE]);
  });

  it("keeps the reasoning level", () => {
    expect(readParameters({ reasoning: "off" }).reasoning).toBe("off");
  });

  it("gives the schema as compact --json-schema text and builds its validator", () => {
    const schema = { type: "object", properties: { score: { type: "number" } } };

    const params = readParameters({ responseSchema: schema });

    expect(params.schema?.text).toBe(JSON.stringify(schema));
    expect(params.schema?.viaFlag).toBe(true);
    expect(params.schema?.validator.safeParse({ score: 1 }).success).toBe(true);
    expect(params.schema?.validator.safeParse({ score: "1" }).success).toBe(false);
  });

  it("drops a top-level $schema from the flag text, which --json-schema rejects, and keeps it for zod", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      propertyNames: { pattern: "^t" },
      additionalProperties: { type: "string" }
    };

    const params = readParameters({ responseSchema: schema });

    expect(params.schema?.text).toBe(
      '{"type":"object","propertyNames":{"pattern":"^t"},"additionalProperties":{"type":"string"}}'
    );
    expect(params.schema?.validator.safeParse({ t1: "a" }).success).toBe(true);
    expect(params.schema?.validator.safeParse({ t1: 1 }).success).toBe(false);
  });

  it.each([
    ["an array root", { type: "array", items: { type: "number" } }],
    ["a root without type", { properties: { score: { type: "number" } } }]
  ])("sends %s through the prompt, as --json-schema takes only type object", (_label, schema) => {
    expect(readParameters({ responseSchema: schema }).schema?.viaFlag).toBe(false);
  });

  it("rejects images that are not image files", () => {
    expect(() => readParameters({ images: [{ path: "/a.png" }] })).toThrow(
      "[ai] Claude params.images must be image files.\n  Pass { path, mimeType, hash } for every image."
    );
    expect(() => readParameters({ images: "a.png" })).toThrow("params.images must be image files");
  });

  it("rejects a responseSchema that is not a JSON schema object", () => {
    const message =
      "[ai] Claude params.responseSchema must be a JSON schema object.\n  Pass the schema as a plain object.";

    expect(() => readParameters({ responseSchema: "{}" })).toThrow(message);
    expect(() => readParameters({ responseSchema: [] })).toThrow(message);
    expect(() => readParameters({ responseSchema: { type: 5 } })).toThrow(message);
  });

  it("rejects an unknown reasoning level, quoting it", () => {
    expect(() => readParameters({ reasoning: "max" })).toThrow(
      '[ai] Claude params.reasoning must be off, low, medium or high.\n  Got "max".'
    );
  });
});
