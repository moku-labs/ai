import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { createBuildfileApi } from "../../api";
import { defineBuild } from "../../define";
import { buildItemSchema, buildSpecSchema, firstIssueMessage } from "../../schema";
import type { BuildfileApi, BuildfileContext, BuildSpec, CompiledBuild, Config } from "../../types";

/**
 * Builds a mock buildfile context (config + empty state + no-op emit).
 */
function createTestCtx(overrides?: Partial<Config>): BuildfileContext {
  const config: Config = {
    defaultGlob: "**/*.moku.yaml",
    schemaPath: ".moku/build.schema.json",
    ...overrides
  };
  // buildfile declares no events — emit is a typed no-op returning undefined.
  return { config, state: {}, emit: () => undefined };
}

describe("buildfile unit", () => {
  // ---------------------------------------------------------------------
  // schema
  // ---------------------------------------------------------------------

  describe("schema: buildItemSchema", () => {
    it("accepts a minimal item (task + input only)", () => {
      const result = buildItemSchema.safeParse({ task: "voiceover", input: { text: "hi" } });
      expect(result.success).toBe(true);
    });

    it("accepts a full item with id, provider, params, and pack", () => {
      const result = buildItemSchema.safeParse({
        task: "voiceover",
        id: "intro",
        provider: "elevenlabs",
        input: { text: "hi", voice: "v1" },
        params: { stability: 0.5 },
        pack: { name: "narration", version: "1.0.0" }
      });
      expect(result.success).toBe(true);
    });

    it("rejects an item missing task", () => {
      const result = buildItemSchema.safeParse({ input: {} });
      expect(result.success).toBe(false);
    });

    it("rejects an item whose input is not an object", () => {
      const result = buildItemSchema.safeParse({ task: "voiceover", input: "nope" });
      expect(result.success).toBe(false);
    });
  });

  describe("schema: buildSpecSchema", () => {
    it("accepts a minimal spec", () => {
      const result = buildSpecSchema.safeParse({ version: 1, name: "demo", items: [] });
      expect(result.success).toBe(true);
    });

    it("accepts defaults.provider and defaults.maxAttempts", () => {
      const result = buildSpecSchema.safeParse({
        version: 1,
        name: "demo",
        defaults: { provider: "elevenlabs", maxAttempts: 3 },
        items: []
      });
      expect(result.success).toBe(true);
    });

    it("accepts itemsFrom", () => {
      const result = buildSpecSchema.safeParse({
        version: 1,
        name: "demo",
        items: [],
        itemsFrom: "extra.ndjson"
      });
      expect(result.success).toBe(true);
    });

    it("rejects a version other than 1", () => {
      const result = buildSpecSchema.safeParse({ version: 2, name: "demo", items: [] });
      expect(result.success).toBe(false);
    });
  });

  describe("schema: firstIssueMessage", () => {
    it("formats the dotted path and message of the first issue", () => {
      const result = buildSpecSchema.safeParse({ version: 2, name: "x", items: [] });
      if (result.success) throw new Error("expected failure");
      expect(firstIssueMessage(result.error)).toMatch(/^version: /);
    });

    it("uses (root) when the issue path is empty", () => {
      const result = buildSpecSchema.safeParse("not an object");
      if (result.success) throw new Error("expected failure");
      expect(firstIssueMessage(result.error)).toMatch(/^\(root\): /);
    });
  });

  // ---------------------------------------------------------------------
  // api: compile — validation errors (pinned two-line format)
  // ---------------------------------------------------------------------

  describe("api: compile — validation errors", () => {
    const api = createBuildfileApi(createTestCtx());

    it("rejects a bad version with the exact two-line error", async () => {
      await expect(
        api.compile({ text: "version: 2\nname: x\nitems: []\n", lang: "yaml" })
      ).rejects.toThrow('[ai] Build file "<inline>" is invalid.\n  version:');
    });

    it("rejects a missing task with the exact two-line error", async () => {
      await expect(
        api.compile({ text: "version: 1\nname: x\nitems:\n  - input: {}\n", lang: "yaml" })
      ).rejects.toThrow('[ai] Build file "<inline>" is invalid.\n  items.0.task:');
    });

    it("rejects non-object input with the exact two-line error", async () => {
      await expect(
        api.compile({
          text: 'version: 1\nname: x\nitems:\n  - task: t\n    input: "nope"\n',
          lang: "yaml"
        })
      ).rejects.toThrow('[ai] Build file "<inline>" is invalid.\n  items.0.input:');
    });

    it("matches the exact pinned two-line format", async () => {
      await expect(
        api.compile({ text: "version: 2\nname: x\nitems: []\n", lang: "yaml" })
      ).rejects.toThrow(/^\[ai] Build file "<inline>" is invalid\.\n {2}.+\.$/);
    });
  });

  // ---------------------------------------------------------------------
  // api: compile — itemsFrom NDJSON expansion
  // ---------------------------------------------------------------------

  describe("api: compile — itemsFrom NDJSON expansion", () => {
    let tempDir: string;
    let api: BuildfileApi;

    async function setUp(): Promise<void> {
      tempDir = await mkdtemp(path.join(tmpdir(), "moku-buildfile-ndjson-"));
      api = createBuildfileApi(createTestCtx());
    }

    async function tearDown(): Promise<void> {
      await rm(tempDir, { recursive: true, force: true });
    }

    it("merges valid NDJSON lines into spec.items", async () => {
      await setUp();
      try {
        const yamlPath = path.join(tempDir, "build.moku.yaml");
        await writeFile(
          yamlPath,
          "version: 1\nname: ndjson-demo\nitems: []\nitemsFrom: items.ndjson\n"
        );
        const ndjsonPath = path.join(tempDir, "items.ndjson");
        await writeFile(
          ndjsonPath,
          [
            JSON.stringify({ task: "voiceover", input: { text: "one", voice: "v1" } }),
            "",
            JSON.stringify({ task: "translate", input: { text: "two", targetLang: "es" } })
          ].join("\n")
        );

        const compiled = await api.compile({ path: yamlPath });

        expect(compiled.spec.items).toHaveLength(2);
        expect(compiled.spec.items[0]?.task).toBe("voiceover");
        expect(compiled.spec.items[1]?.task).toBe("translate");
      } finally {
        await tearDown();
      }
    });

    it("reports the line number of a malformed JSON line", async () => {
      await setUp();
      try {
        const yamlPath = path.join(tempDir, "build.moku.yaml");
        await writeFile(
          yamlPath,
          "version: 1\nname: ndjson-bad\nitems: []\nitemsFrom: items.ndjson\n"
        );
        const ndjsonPath = path.join(tempDir, "items.ndjson");
        await writeFile(
          ndjsonPath,
          `${JSON.stringify({ task: "voiceover", input: {} })}\n{not valid json\n`
        );

        await expect(api.compile({ path: yamlPath })).rejects.toThrow(
          `[ai] Build file "${yamlPath}" is invalid.\n  itemsFrom line 2:`
        );
      } finally {
        await tearDown();
      }
    });

    it("reports the line number and issue path when a NDJSON line fails schema validation", async () => {
      await setUp();
      try {
        const yamlPath = path.join(tempDir, "build.moku.yaml");
        await writeFile(
          yamlPath,
          "version: 1\nname: ndjson-invalid-item\nitems: []\nitemsFrom: items.ndjson\n"
        );
        const ndjsonPath = path.join(tempDir, "items.ndjson");
        await writeFile(ndjsonPath, `${JSON.stringify({ input: {} })}\n`);

        await expect(api.compile({ path: yamlPath })).rejects.toThrow(
          `[ai] Build file "${yamlPath}" is invalid.\n  itemsFrom line 1: task:`
        );
      } finally {
        await tearDown();
      }
    });
  });

  // ---------------------------------------------------------------------
  // api: loadGlob — deterministic ordering
  // ---------------------------------------------------------------------

  describe("api: loadGlob — deterministic ordering", () => {
    it("returns compiled builds in sorted path order regardless of creation order", async () => {
      const tempDir = await mkdtemp(path.join(tmpdir(), "moku-buildfile-glob-"));
      try {
        await mkdir(path.join(tempDir, "nested"), { recursive: true });
        const zPath = path.join(tempDir, "z.moku.yaml");
        const aPath = path.join(tempDir, "nested", "a.moku.yaml");
        // Written in reverse-alphabetical order to prove the output order is
        // sorted, not filesystem enumeration/creation order.
        await writeFile(zPath, "version: 1\nname: z\nitems: []\n");
        await writeFile(aPath, "version: 1\nname: a\nitems: []\n");

        const api = createBuildfileApi(
          createTestCtx({ defaultGlob: path.join(tempDir, "**/*.moku.yaml") })
        );
        const compiled = await api.loadGlob();

        expect(compiled.map(build => build.file)).toEqual([aPath, zPath].toSorted());
        expect(compiled.map(build => build.spec.name)).toEqual(["a", "z"]);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  // ---------------------------------------------------------------------
  // api: jsonSchema
  // ---------------------------------------------------------------------

  describe("api: jsonSchema", () => {
    const api = createBuildfileApi(createTestCtx());

    it("returns a JSON Schema object generated from the zod schema", () => {
      const schema = api.jsonSchema();
      expect(schema.type).toBe("object");
      expect(schema.required).toEqual(["version", "name", "items"]);
    });

    it("round-trips: the rendered template's fields satisfy the JSON Schema's required fields", async () => {
      const schema = api.jsonSchema();
      const text = api.template({ name: "roundtrip" });
      const compiled = await api.compile({ text, lang: "yaml" });

      const required = schema.required;
      if (!Array.isArray(required))
        throw new Error("expected jsonSchema().required to be an array");

      const specKeys = Object.keys(compiled.spec);
      for (const key of required) {
        expect(typeof key).toBe("string");
        expect(specKeys).toContain(key);
      }
    });
  });

  // ---------------------------------------------------------------------
  // api: template
  // ---------------------------------------------------------------------

  describe("api: template", () => {
    const api = createBuildfileApi(createTestCtx({ schemaPath: ".moku/build.schema.json" }));

    it("contains both the yaml-language-server modeline and the $schema key", () => {
      const text = api.template({ name: "demo" });
      expect(text).toContain("# yaml-language-server: $schema=.moku/build.schema.json");
      expect(text).toContain("$schema: .moku/build.schema.json");
    });

    it("contains the given name and a commented example per M0 task", () => {
      const text = api.template({ name: "demo" });
      expect(text).toContain('name: "demo"');
      expect(text).toContain("task: voiceover");
      expect(text).toContain("task: translate");
      expect(text).toContain("task: prompt-gen");
    });

    it("itself compiles into a valid, minimal BuildSpec", async () => {
      const text = api.template({ name: "demo" });
      const compiled = await api.compile({ text, lang: "yaml" });
      expect(compiled.spec).toEqual({ version: 1, name: "demo", items: [] });
    });
  });

  // ---------------------------------------------------------------------
  // define: defineBuild
  // ---------------------------------------------------------------------

  describe("define: defineBuild", () => {
    it("returns the same valid spec (identity)", () => {
      const spec: BuildSpec = { version: 1, name: "demo", items: [] };
      expect(defineBuild(spec)).toEqual(spec);
    });

    it("throws the pinned two-line error for a spec that fails schema validation", () => {
      // Deliberately bypasses the static BuildSpec type to exercise the
      // runtime defense-in-depth guard (see the @ts-expect-error test below
      // for the compile-time rejection of the same shape).
      const invalid = { version: 1, name: "demo", items: [{ input: {} }] } as unknown as BuildSpec;
      expect(() => defineBuild(invalid)).toThrow(
        /^\[ai] Build file "<inline>" is invalid\.\n {2}.+\.$/
      );
    });
  });

  // ---------------------------------------------------------------------
  // types
  // ---------------------------------------------------------------------

  describe("types: BuildSpec/BuildItem", () => {
    it("BuildSpec matches z.infer<typeof buildSpecSchema>", () => {
      expectTypeOf<BuildSpec>().toEqualTypeOf<z.infer<typeof buildSpecSchema>>();
    });

    it("defineBuild rejects a wrong-shaped literal at compile time", () => {
      expect(() => {
        // @ts-expect-error -- missing required "items" field
        defineBuild({ version: 1, name: "bad" });
      }).toThrow('[ai] Build file "<inline>" is invalid.\n  items:');
    });
  });

  describe("types: BuildfileApi", () => {
    it("compile returns a Promise<CompiledBuild>", () => {
      expectTypeOf<BuildfileApi["compile"]>().returns.resolves.toEqualTypeOf<CompiledBuild>();
    });

    it("loadGlob accepts an optional pattern and returns CompiledBuild[]", () => {
      expectTypeOf<BuildfileApi["loadGlob"]>().parameter(0).toEqualTypeOf<string | undefined>();
      expectTypeOf<BuildfileApi["loadGlob"]>().returns.resolves.toEqualTypeOf<CompiledBuild[]>();
    });

    it("jsonSchema returns Record<string, unknown>", () => {
      expectTypeOf<BuildfileApi["jsonSchema"]>().returns.toEqualTypeOf<Record<string, unknown>>();
    });

    it("template accepts { name: string } and returns string", () => {
      expectTypeOf<BuildfileApi["template"]>().parameter(0).toEqualTypeOf<{ name: string }>();
      expectTypeOf<BuildfileApi["template"]>().returns.toEqualTypeOf<string>();
    });
  });
});
