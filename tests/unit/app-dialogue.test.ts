import { describe, expect, it } from "vitest";
import * as root from "../../src/index";
import { createApp } from "../../src/index";

describe("framework createApp: dialogue wiring", () => {
  it("mounts app.dialogue in the default app", () => {
    const app = createApp({});

    expect(Object.keys(app.dialogue).toSorted()).toEqual(["estimate", "generate", "providers"]);
  });
});

describe("framework exports: dialogue", () => {
  it("ships dialoguePlugin and no runtime values from the Dialogue type namespace", () => {
    expect(Object.keys(root)).toContain("dialoguePlugin");
    expect(Object.keys(root.Dialogue)).toEqual([]);
  });
});
