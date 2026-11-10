import { describe, expect, it } from "vitest";
import { createBuildfileApi } from "../../api";
import { buildItemSchema, buildSpecSchema } from "../../schema";
import type { BuildfileContext } from "../../types";

/** A mock buildfile context (config + empty state + no-op emit). */
function createTestCtx(): BuildfileContext {
  const config = { defaultGlob: "**/*.moku.yaml", schemaPath: ".moku/build.schema.json" };
  return { config, state: {}, emit: () => undefined };
}

const api = createBuildfileApi(createTestCtx());

/** The scene the game will use: a dialogue and a voiceover over a ru/en cast. */
const SCENE = `
version: 1
name: audio
defaults: { provider: elevenlabs }
locales: [ru, en]
cast:
  alice:
    voice: ru-alice
    locales:
      en: { voice: en-alice }
  mira:
    voice: ru-mira
    settings: { stability: 0.5 }
    locales:
      en: { voice: en-mira, settings: { stability: 0.6 } }
items:
  - id: voices/ep02-quarrel-\${locale}
    task: dialogue
    locales: true
    input:
      model: eleven_v4
      language: \${locale}
      seed: 7
      lines:
        - { id: "ep02-signAlice-\${locale}", $cast: alice, text: { ru: "Привет", en: "Hello" } }
  - id: voices/promo-line3
    task: voiceover
    locales: true
    input:
      $cast: mira
      model: eleven_v4
      language: \${locale}
      text: { ru: "Новый пациент.", en: "A new patient." }
`;

describe("buildfile integration: locales and cast", () => {
  it("compiles one scene into one item per locale, with per-locale voices and settings", async () => {
    const { spec } = await api.compile({ text: SCENE, lang: "yaml" });

    expect(spec.items.map(item => item.id)).toEqual([
      "voices/ep02-quarrel-ru",
      "voices/ep02-quarrel-en",
      "voices/promo-line3-ru",
      "voices/promo-line3-en"
    ]);
    expect(spec.items[1]?.input).toEqual({
      model: "eleven_v4",
      language: "en",
      seed: 7,
      lines: [{ id: "ep02-signAlice-en", voice: "en-alice", text: "Hello" }]
    });
    expect(spec.items[2]?.input).toMatchObject({
      voice: "ru-mira",
      settings: { stability: 0.5 },
      language: "ru",
      text: "Новый пациент."
    });
    expect(spec.items[3]?.input).toMatchObject({
      voice: "en-mira",
      settings: { stability: 0.6 },
      text: "A new patient."
    });
    expect(spec.items.every(item => !("locales" in item))).toBe(true);
    expect(spec.locales).toEqual(["ru", "en"]);
    expect(Object.keys(spec.cast ?? {})).toEqual(["alice", "mira"]);
  });

  it("gives each locale item its own input, so each has its own planning key", async () => {
    const { spec } = await api.compile({ text: SCENE, lang: "yaml" });

    expect(JSON.stringify(spec.items[0]?.input)).not.toBe(JSON.stringify(spec.items[1]?.input));
  });

  it("reports an expansion error in the pinned two-line format", async () => {
    const text = SCENE.replace('{ ru: "Привет", en: "Hello" }', '{ ru: "Привет" }');

    await expect(api.compile({ text, lang: "yaml" })).rejects.toThrow(
      new Error(
        '[ai] Build file "<inline>" is invalid.\n  items.0.input.lines.0.text: no "en" value.'
      )
    );
  });

  it("still catches a duplicate id after expansion", async () => {
    const text = `version: 1
name: x
locales: [ru, en]
items:
  - { id: a, task: voiceover, locales: true, input: {} }
  - { id: a-ru, task: voiceover, input: {} }
`;

    await expect(api.compile({ text, lang: "yaml" })).rejects.toThrow('duplicate id "a-ru"');
  });

  it("compiles a build file without cast or locales to the spec it always did", async () => {
    const text = `version: 1
name: plain
defaults: { provider: elevenlabs, maxAttempts: 2 }
items:
  - { id: "s01.key", task: image, input: { prompt: "p", size: { width: 1, height: 2 } } }
  - { id: "s01.clip", task: video, provider: x, input: { image: { $ref: "s01.key" }, t: "\${locale}" }, params: { r: 1 } }
`;

    const { spec } = await api.compile({ text, lang: "yaml" });

    expect(spec).toEqual({
      version: 1,
      name: "plain",
      defaults: { provider: "elevenlabs", maxAttempts: 2 },
      items: [
        { id: "s01.key", task: "image", input: { prompt: "p", size: { width: 1, height: 2 } } },
        {
          id: "s01.clip",
          task: "video",
          provider: "x",
          input: { image: { $ref: "s01.key" }, t: `\${locale}` },
          params: { r: 1 }
        }
      ]
    });
  });
});

describe("buildfile integration: starter template", () => {
  it("carries a dialogue example that compiles once uncommented", async () => {
    const text = api.template({ name: "demo" });
    const examples = text
      .split("# Example items — uncomment and edit to use:\n#\n")[1]
      ?.replaceAll(/^# ?/gm, "  ");

    const { spec } = await api.compile({
      text: `version: 1\nname: demo\nitems:\n${examples ?? ""}`,
      lang: "yaml"
    });

    const dialogue = spec.items.find(item => item.task === "dialogue");
    expect(dialogue?.input.lines).toHaveLength(2);
  });
});

describe("buildfile integration: schema for locales and cast", () => {
  it("lists `cast` and `locales` in the JSON Schema, at the top level and on an item", () => {
    const schema = api.jsonSchema();
    const top = schema.properties as Record<string, { items?: { properties?: object } }>;

    expect(Object.keys(top)).toEqual(expect.arrayContaining(["cast", "locales"]));
    expect(Object.keys(top.items?.items?.properties ?? {})).toContain("locales");
  });

  it("accepts the locale placeholder in an id, with and without a nine-slice hint", () => {
    for (const id of [`voices/ep02-\${locale}`, `button-\${locale}{nine=1,2,3,4}`]) {
      expect(buildItemSchema.safeParse({ task: "sprite", id, input: {} }).success).toBe(true);
    }
  });

  it("still refuses a malformed hint next to the placeholder", () => {
    const result = buildItemSchema.safeParse({
      task: "sprite",
      id: `button-\${locale}{nine=1,2,3}`,
      input: {}
    });

    expect(result.success).toBe(false);
  });

  it.each([
    ["an empty list", []],
    ["a duplicate", ["ru", "ru"]],
    ["a malformed code", ["RU"]]
  ])("refuses top-level locales with %s", (_case, locales) => {
    const result = buildSpecSchema.safeParse({ version: 1, name: "x", locales, items: [] });

    expect(result.success).toBe(false);
  });

  it("accepts region-tagged locales and item `locales: true`", () => {
    const result = buildSpecSchema.safeParse({
      version: 1,
      name: "x",
      locales: ["ru", "pt-BR"],
      items: [{ task: "voiceover", id: "a", locales: true, input: {} }]
    });

    expect(result.success).toBe(true);
  });
});
