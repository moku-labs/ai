import { describe, expect, it } from "vitest";
import * as root from "../../src/index";
import { createApp } from "../../src/index";

describe("framework createApp: sfx and sprite wiring", () => {
  it("serves sfx from elevenlabs and fal, elevenlabs first", () => {
    const app = createApp({});

    expect(app.sfx.providers()).toEqual(["elevenlabs", "fal"]);
  });

  it("serves sprite from fal", () => {
    const app = createApp({});

    expect(app.sprite.providers()).toEqual(["fal"]);
  });

  it("lists both tasks in the registry", () => {
    const app = createApp({});

    expect(app.registry.tasks()).toEqual(expect.arrayContaining(["sfx", "sprite"]));
  });
});

describe("framework exports: sfx and sprite", () => {
  it("ships no runtime values from the Sfx and Sprite type namespaces", () => {
    expect(Object.keys(root.Sfx)).toEqual([]);
    expect(Object.keys(root.Sprite)).toEqual([]);
  });

  it("keeps processSprite off the root export", () => {
    expect(Object.keys(root)).not.toContain("processSprite");
  });
});
