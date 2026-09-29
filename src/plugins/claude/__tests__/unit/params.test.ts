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

  it("pretty-prints the schema and builds its validator", () => {
    const schema = { type: "object", properties: { score: { type: "number" } } };

    const params = readParameters({ responseSchema: schema });

    expect(params.schema?.text).toBe(JSON.stringify(schema, undefined, 2));
    expect(params.schema?.validator.safeParse({ score: 1 }).success).toBe(true);
    expect(params.schema?.validator.safeParse({ score: "1" }).success).toBe(false);
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
