import { describe, expect, it } from "vitest";
import { createBuildfileApi } from "../../api";
import { checkReferenceGraph, collectReferences } from "../../references";
import type { BuildItem } from "../../types";

/**
 * Compiles inline YAML items through the real buildfile API.
 *
 * @param items - The `items:` block, already indented by two spaces.
 * @returns The compile promise.
 * @example
 * ```ts
 * await compileItems("  - task: image\n    input: {}\n");
 * ```
 */
function compileItems(items: string) {
  const api = createBuildfileApi({
    config: { defaultGlob: "**/*.moku.yaml", schemaPath: ".moku/build.schema.json" },
    state: {},
    emit: () => undefined
  });
  return api.compile({ text: `version: 1\nname: refs\nitems:\n${items}`, lang: "yaml" });
}

/**
 * A build item with just a task, id and input.
 *
 * @param id - Item id, or undefined.
 * @param input - Item input.
 * @returns The item.
 * @example
 * ```ts
 * item("a", { image: { $ref: "b" } });
 * ```
 */
function item(id: string | undefined, input: Record<string, unknown>): BuildItem {
  return id === undefined ? { task: "image", input } : { task: "image", id, input };
}

describe("collectReferences", () => {
  it("finds $ref and $file values in nested objects and arrays, in order", () => {
    expect(
      collectReferences({
        image: { $ref: "key" },
        refs: [{ $file: "a.png" }, { nested: { $ref: "other" } }],
        prompt: "text"
      })
    ).toEqual({ refs: ["key", "other"], files: ["a.png"] });
  });

  it("treats an object with extra keys as plain data", () => {
    expect(collectReferences({ x: { $ref: "a", note: "b" } })).toEqual({ refs: [], files: [] });
  });
});

describe("checkReferenceGraph", () => {
  it("accepts a valid chain", () => {
    expect(
      checkReferenceGraph([item("a", {}), item("b", { image: { $ref: "a" } })])
    ).toBeUndefined();
  });

  it("reports a duplicate id", () => {
    expect(checkReferenceGraph([item("a", {}), item("a", {})])).toBe(
      'items.1.id: duplicate id "a"'
    );
  });

  it("reports an unknown target", () => {
    expect(checkReferenceGraph([item(undefined, { image: { $ref: "nope" } })])).toBe(
      'items.0.input: unknown $ref "nope"'
    );
  });

  it("reports a malformed reference value", () => {
    expect(checkReferenceGraph([item("a", { refs: [{ $file: 3 }] })])).toBe(
      "items.0.input: $file must be a non-empty string"
    );
    expect(checkReferenceGraph([item("a", { image: { $ref: "" } })])).toBe(
      "items.0.input: $ref must be a non-empty string"
    );
  });

  it("reports a cycle with its path", () => {
    expect(
      checkReferenceGraph([
        item("a", { image: { $ref: "b" } }),
        item("b", { image: { $ref: "a" } })
      ])
    ).toBe("items: $ref cycle a -> b -> a");
  });
});

describe("compile() reference checks", () => {
  it("rejects an unknown $ref with the two-line build-file error", async () => {
    await expect(
      compileItems("  - task: video\n    input: { image: { $ref: missing } }\n")
    ).rejects.toThrow(
      '[ai] Build file "<inline>" is invalid.\n  items.0.input: unknown $ref "missing".'
    );
  });

  it("compiles a valid image -> video chain", async () => {
    const compiled = await compileItems(
      "  - id: key\n    task: image\n    input: { prompt: p }\n  - task: video\n    input: { image: { $ref: key } }\n"
    );
    expect(compiled.spec.items).toHaveLength(2);
  });
});
