import { describe, expect, it } from "vitest";
import { localizeItems } from "../../localize";
import type { BuildItem, BuildSpec } from "../../types";

type Spec = Pick<BuildSpec, "locales" | "cast">;

/** Expands and returns the items, failing the test when the expansion reports a problem. */
function expand(spec: Spec, items: BuildItem[]): BuildItem[] {
  const result = localizeItems(spec, items);
  if ("problem" in result) throw new Error(`unexpected problem: ${result.problem}`);
  return result.items;
}

/** Expands and returns the problem text, failing the test when the expansion succeeds. */
function problemOf(spec: Spec, items: BuildItem[]): string {
  const result = localizeItems(spec, items);
  if ("problem" in result) return result.problem;
  throw new Error("expected a problem");
}

const BOTH: Spec = { locales: ["ru", "en"] };

describe("localize unit: expansion and ids", () => {
  it("expands `locales: true` over the top-level list, in order, in place", () => {
    const items: BuildItem[] = [
      { task: "image", id: "before", input: {} },
      { task: "voiceover", id: "line", locales: true, input: { text: "x" } },
      { task: "image", id: "after", input: {} }
    ];

    const ids = expand(BOTH, items).map(item => item.id);

    expect(ids).toEqual(["before", "line-ru", "line-en", "after"]);
  });

  it("expands over the item's own list when it names one", () => {
    const items: BuildItem[] = [
      { task: "voiceover", id: "line", locales: ["en"], input: { text: "x" } }
    ];

    expect(expand(BOTH, items).map(item => item.id)).toEqual(["line-en"]);
  });

  it("replaces the locale placeholder in the id instead of appending a suffix", () => {
    const items: BuildItem[] = [
      { task: "voiceover", id: `voices/ep02-\${locale}`, locales: true, input: {} }
    ];

    expect(expand(BOTH, items).map(item => item.id)).toEqual(["voices/ep02-ru", "voices/ep02-en"]);
  });

  it("puts the -L suffix before a trailing nine-slice hint", () => {
    const items: BuildItem[] = [
      { task: "sprite", id: "button{nine=1,2,3,4}", locales: ["ru"], input: {} }
    ];

    expect(expand(BOTH, items).map(item => item.id)).toEqual(["button-ru{nine=1,2,3,4}"]);
  });

  it("keeps a placeholder id with a nine-slice hint in place", () => {
    const items: BuildItem[] = [
      { task: "sprite", id: `button-\${locale}{nine=1,2,3,4}`, locales: ["en"], input: {} }
    ];

    expect(expand(BOTH, items).map(item => item.id)).toEqual(["button-en{nine=1,2,3,4}"]);
  });

  it("drops the item-level `locales` key and copies provider, params and pack through", () => {
    const items: BuildItem[] = [
      {
        task: "voiceover",
        id: "line",
        provider: "elevenlabs",
        locales: true,
        input: { text: "x" },
        params: { seed: 1 },
        pack: { name: "p", version: "1" }
      }
    ];

    const [first] = expand(BOTH, items);

    expect(first).toEqual({
      task: "voiceover",
      id: "line-ru",
      provider: "elevenlabs",
      input: { text: "x" },
      params: { seed: 1 },
      pack: { name: "p", version: "1" }
    });
    expect(first).not.toHaveProperty("locales");
  });
});

describe("localize unit: expansion errors", () => {
  it("refuses `locales: true` without a top-level list", () => {
    const items: BuildItem[] = [
      { task: "voiceover", id: "a", input: {} },
      { task: "voiceover", id: "b", locales: true, input: {} }
    ];

    expect(problemOf({}, items)).toBe("items.1.locales: true needs a top-level locales list");
  });

  it("refuses an item locale that is not in the top-level list", () => {
    const items: BuildItem[] = [{ task: "voiceover", id: "a", locales: ["ru", "fr"], input: {} }];

    expect(problemOf(BOTH, items)).toBe(
      'items.0.locales: "fr" is not in the top-level locales list'
    );
  });

  it("accepts any item locale when there is no top-level list", () => {
    const items: BuildItem[] = [{ task: "voiceover", id: "a", locales: ["fr"], input: {} }];

    expect(expand({}, items).map(item => item.id)).toEqual(["a-fr"]);
  });

  it("refuses an expanding item without an id", () => {
    const items: BuildItem[] = [{ task: "voiceover", locales: true, input: {} }];

    expect(problemOf(BOTH, items)).toBe("items.0.id: a localized item needs an id");
  });
});

describe("localize unit: values", () => {
  it("picks the current locale from a localized value and names the path when it is missing", () => {
    const items: BuildItem[] = [
      {
        task: "dialogue",
        id: `d-\${locale}`,
        locales: true,
        input: { lines: [{ text: "a" }, { text: "b" }, { text: { ru: "я", en: "me" } }] }
      }
    ];

    const [ru, en] = expand(BOTH, items);
    expect(ru?.input).toEqual({ lines: [{ text: "a" }, { text: "b" }, { text: "я" }] });
    expect(en?.input).toEqual({ lines: [{ text: "a" }, { text: "b" }, { text: "me" }] });

    const broken: BuildItem[] = [
      {
        task: "dialogue",
        id: `d-\${locale}`,
        locales: true,
        input: { lines: [{ text: "a" }, { text: "b" }, { text: { ru: "я" } }] }
      }
    ];
    expect(problemOf(BOTH, broken)).toBe('items.0.input.lines.2.text: no "en" value');
  });

  it("recognises a localized value by the union of top-level and item locales", () => {
    const items: BuildItem[] = [
      {
        task: "voiceover",
        id: "a",
        locales: ["ru"],
        input: { text: { ru: "я", en: "me" } }
      }
    ];

    expect(expand(BOTH, items)[0]?.input).toEqual({ text: "я" });
  });

  it("does not mistake an object with non-locale keys for a localized value", () => {
    const items: BuildItem[] = [
      {
        task: "sprite",
        id: "s",
        locales: true,
        input: { size: { width: 128, height: 64 }, mixed: { ru: "x", width: 1 }, empty: {} }
      }
    ];

    expect(expand(BOTH, items)[0]?.input).toEqual({
      size: { width: 128, height: 64 },
      mixed: { ru: "x", width: 1 },
      empty: {}
    });
  });

  it("replaces the placeholder in nested strings, params and $ref/$file objects", () => {
    const items: BuildItem[] = [
      {
        task: "video",
        id: `v-\${locale}`,
        locales: ["en"],
        input: {
          language: `\${locale}`,
          image: { $ref: `key-\${locale}` },
          refs: [{ $file: `refs/\${locale}/a.png` }],
          note: "no placeholder"
        },
        params: { tag: `t-\${locale}` }
      }
    ];

    const [first] = expand(BOTH, items);

    expect(first?.input).toEqual({
      language: "en",
      image: { $ref: "key-en" },
      refs: [{ $file: "refs/en/a.png" }],
      note: "no placeholder"
    });
    expect(first?.params).toEqual({ tag: "t-en" });
  });

  it("refuses an `input` that a localized value would turn into a non-object", () => {
    const items: BuildItem[] = [
      { task: "voiceover", id: "a", locales: ["en"], input: { ru: { text: "я" }, en: "plain" } }
    ];

    expect(problemOf(BOTH, items)).toBe("items.0.input: must be an object");
  });

  it("walks a localized value's picked entry, so a placeholder inside it is replaced too", () => {
    const items: BuildItem[] = [
      {
        task: "voiceover",
        id: "a",
        locales: ["en"],
        input: { text: { ru: "x", en: `hello (\${locale})` } }
      }
    ];

    expect(expand(BOTH, items)[0]?.input).toEqual({ text: "hello (en)" });
  });
});

describe("localize unit: $cast", () => {
  const cast: Spec["cast"] = {
    mira: {
      voice: "mira-ru",
      settings: { stability: 0.5 },
      locales: { en: { voice: "mira-en", settings: { stability: 0.6 } } }
    }
  };

  it("merges the base fields with the locale override, and the object's own keys win", () => {
    const items: BuildItem[] = [
      {
        task: "voiceover",
        id: "a",
        locales: true,
        input: { $cast: "mira", text: "hi", model: "m" }
      },
      {
        task: "voiceover",
        id: "b",
        locales: ["ru"],
        input: { $cast: "mira", text: "hi", voice: "mine" }
      }
    ];

    const [ru, en, own] = expand({ ...BOTH, cast }, items);

    expect(ru?.input).toEqual({
      voice: "mira-ru",
      settings: { stability: 0.5 },
      text: "hi",
      model: "m"
    });
    expect(en?.input).toEqual({
      voice: "mira-en",
      settings: { stability: 0.6 },
      text: "hi",
      model: "m"
    });
    expect(own?.input).toEqual({ voice: "mine", settings: { stability: 0.5 }, text: "hi" });
  });

  it("resolves a $cast nested in lines, and never leaks `locales` or `$cast` into the result", () => {
    const items: BuildItem[] = [
      {
        task: "dialogue",
        id: "d",
        locales: ["en"],
        input: { lines: [{ id: `l-\${locale}`, $cast: "mira", text: "hi" }] }
      }
    ];

    expect(expand({ ...BOTH, cast }, items)[0]?.input).toEqual({
      lines: [{ id: "l-en", voice: "mira-en", settings: { stability: 0.6 }, text: "hi" }]
    });
  });

  it("refuses an unknown cast member and names the path", () => {
    const items: BuildItem[] = [
      { task: "dialogue", id: "d", locales: true, input: { lines: [{ $cast: "bob", text: "x" }] } }
    ];

    expect(problemOf({ ...BOTH, cast }, items)).toBe(
      'items.0.input.lines.0.$cast: no cast member "bob"'
    );
  });

  it("gives a non-localized item the base fields only and leaves its placeholders alone", () => {
    const items: BuildItem[] = [
      {
        task: "voiceover",
        id: `keep-\${locale}`,
        input: { $cast: "mira", text: `t-\${locale}`, alt: { ru: "a", en: "b" } }
      }
    ];

    const [only] = expand({ ...BOTH, cast }, items);

    expect(only).toEqual({
      task: "voiceover",
      id: `keep-\${locale}`,
      input: {
        voice: "mira-ru",
        settings: { stability: 0.5 },
        text: `t-\${locale}`,
        alt: { ru: "a", en: "b" }
      }
    });
  });

  it("refuses a $cast when the build file has no cast at all", () => {
    const items: BuildItem[] = [{ task: "voiceover", id: "a", input: { $cast: "mira" } }];

    expect(problemOf({}, items)).toBe('items.0.input.$cast: no cast member "mira"');
  });
});

describe("localize unit: ids inside a localized item", () => {
  it("refuses an id string inside input that lacks the placeholder", () => {
    const items: BuildItem[] = [
      {
        task: "dialogue",
        id: `d-\${locale}`,
        locales: true,
        input: { lines: [{ id: "signAlice", text: "x" }] }
      }
    ];

    expect(problemOf(BOTH, items)).toBe(
      `items.0.input.lines.0.id: an id inside a localized item needs \${locale}`
    );
  });

  it("accepts a localized-value id and leaves `id` keys in params alone", () => {
    const items: BuildItem[] = [
      {
        task: "dialogue",
        id: `d-\${locale}`,
        locales: true,
        input: { lines: [{ id: { ru: "a-ru", en: "a-en" }, text: "x" }] },
        params: { id: "plain" }
      }
    ];

    const [ru] = expand(BOTH, items);

    expect(ru?.input).toEqual({ lines: [{ id: "a-ru", text: "x" }] });
    expect(ru?.params).toEqual({ id: "plain" });
  });

  it("does not check ids of a non-localized item", () => {
    const items: BuildItem[] = [
      { task: "dialogue", id: "d", input: { lines: [{ id: "plain", text: "x" }] } }
    ];

    expect(expand(BOTH, items)[0]?.input).toEqual({ lines: [{ id: "plain", text: "x" }] });
  });
});
