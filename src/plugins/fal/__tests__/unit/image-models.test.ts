import { describe, expect, it } from "vitest";
import {
  checkImageAspect,
  imageAliases,
  imageResolution,
  promptWithNegative,
  resolveImageModel
} from "../../image/models";
import { TerminalProviderError } from "../../types";

// ─────────────────────────────────────────────────────────────────────────────
// fal image catalog: endpoints, resolution mapping, aspects, body builders.
// ─────────────────────────────────────────────────────────────────────────────

const NANO = resolveImageModel("nano-banana-pro");
const SEEDREAM = resolveImageModel("seedream-4.5-edit");
const GPT = resolveImageModel("gpt-image-2.5");

describe("catalog", () => {
  it("lists the aliases in catalog order", () => {
    expect(imageAliases()).toEqual(["nano-banana-pro", "seedream-4.5-edit", "gpt-image-2.5"]);
  });

  it.each([
    ["nano-banana-pro", "fal-ai/nano-banana-pro", "fal-ai/nano-banana-pro/edit", 14],
    [
      "seedream-4.5-edit",
      "fal-ai/bytedance/seedream/v4.5/text-to-image",
      "fal-ai/bytedance/seedream/v4.5/edit",
      10
    ],
    [
      "gpt-image-2.5",
      "openai/gpt-image-2.5/sunburst/text-to-image",
      "openai/gpt-image-2.5/sunburst/edit",
      16
    ]
  ])("%s: text %s, edit %s, %d refs", (alias, textEndpoint, editEndpoint, maxRefs) => {
    const model = resolveImageModel(alias);
    expect(model.alias).toBe(alias);
    expect(model.textEndpoint).toBe(textEndpoint);
    expect(model.editEndpoint).toBe(editEndpoint);
    expect(model.maxRefs).toBe(maxRefs);
  });

  it("rejects an unknown alias with a terminal 400 listing the aliases", () => {
    let caught: unknown;
    try {
      resolveImageModel("dall-e");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TerminalProviderError);
    expect(caught).toMatchObject({
      status: 400,
      message:
        '[ai] Unknown fal image model "dall-e".\n  Use one of: nano-banana-pro, seedream-4.5-edit, gpt-image-2.5.'
    });
  });
});

describe("imageResolution", () => {
  it.each([
    [NANO, undefined, "1K"],
    [NANO, "1K", "1K"],
    [NANO, "2K", "2K"],
    [NANO, "4K", "4K"],
    [NANO, "1080", "1K"],
    [SEEDREAM, undefined, undefined],
    [SEEDREAM, "2K", "2K"],
    [SEEDREAM, "1080", "1080"],
    [SEEDREAM, "1K", undefined],
    [SEEDREAM, "4K", undefined],
    [GPT, undefined, undefined],
    [GPT, "2K", "2K"],
    [GPT, "1080", "1080"],
    [GPT, "1K", undefined],
    [GPT, "4K", undefined],
    [GPT, 1080, "1080"]
  ])("%#: %s at %s plans %s", (model, asked, planned) => {
    expect(imageResolution(model, asked)).toBe(planned);
  });

  it.each([["8K"], [{ size: 2 }]])("rejects %j with a terminal 400", asked => {
    expect(() => imageResolution(GPT, asked)).toThrow(TerminalProviderError);
    expect(() => imageResolution(NANO, "8K")).toThrow(
      '[ai] fal image resolution "8K" is not supported.\n  Use one of: 1K, 2K, 4K, 1080.'
    );
  });
});

describe("checkImageAspect", () => {
  it("accepts nano's wide aspects", () => {
    expect(() => checkImageAspect(NANO, "21:9", "1K")).not.toThrow();
  });

  it("checks the size table of a sized resolution", () => {
    expect(() => checkImageAspect(GPT, "3:4", "2K")).not.toThrow();
    expect(() => checkImageAspect(SEEDREAM, "4:3", "1080")).not.toThrow();
  });

  it("rejects an aspect the model has no size for, as a terminal 400", () => {
    expect(() => checkImageAspect(SEEDREAM, "21:9", undefined)).toThrow(
      '[ai] fal image model "seedream-4.5-edit" does not support aspect "21:9".\n  Use one of: 9:16, 16:9, 1:1, 3:4, 4:3.'
    );
    expect(() => checkImageAspect(GPT, "5:4", "2K")).toThrow(TerminalProviderError);
  });
});

describe("body builders", () => {
  const input = {
    prompt: "p",
    aspect: "9:16",
    resolution: undefined,
    imageUrls: [],
    quality: undefined
  };

  it("nano-banana-pro sends aspect_ratio and its native resolution", () => {
    expect(NANO.body({ ...input, resolution: "2K" })).toEqual({
      prompt: "p",
      aspect_ratio: "9:16",
      resolution: "2K",
      num_images: 1,
      output_format: "png",
      enable_web_search: false,
      sync_mode: false
    });
  });

  it("adds image_urls only when there are refs", () => {
    expect(NANO.body({ ...input, resolution: "1K", imageUrls: ["u1"] })).toMatchObject({
      image_urls: ["u1"]
    });
    expect(GPT.body(input)).not.toHaveProperty("image_urls");
  });

  it.each([
    [undefined, "9:16", { width: 1440, height: 2560 }],
    [undefined, "16:9", { width: 2560, height: 1440 }],
    [undefined, "1:1", { width: 1920, height: 1920 }],
    [undefined, "3:4", { width: 1920, height: 2560 }],
    [undefined, "4:3", { width: 2560, height: 1920 }],
    ["2K", "9:16", "auto_2K"],
    ["1080", "9:16", "portrait_16_9"],
    ["1080", "16:9", "landscape_16_9"],
    ["1080", "1:1", "square_hd"],
    ["1080", "3:4", "portrait_4_3"],
    ["1080", "4:3", "landscape_4_3"]
  ])("seedream at %s, %s → image_size %j", (resolution, aspect, imageSize) => {
    expect(SEEDREAM.body({ ...input, resolution, aspect })).toEqual({
      prompt: "p",
      image_size: imageSize,
      num_images: 1,
      max_images: 1,
      sync_mode: false
    });
  });

  it.each([
    ["2K", "9:16", { width: 1152, height: 2048 }],
    ["2K", "16:9", { width: 2048, height: 1152 }],
    ["2K", "1:1", { width: 2048, height: 2048 }],
    ["2K", "3:4", { width: 1536, height: 2048 }],
    ["2K", "4:3", { width: 2048, height: 1536 }],
    ["1080", "9:16", "portrait_16_9"],
    [undefined, "4:3", "landscape_4_3"]
  ])("gpt-image at %s, %s → image_size %j", (resolution, aspect, imageSize) => {
    expect(GPT.body({ ...input, resolution, aspect })).toEqual({
      prompt: "p",
      image_size: imageSize,
      quality: "high",
      num_images: 1,
      output_format: "jpeg"
    });
  });

  it.each([
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["ultra", "high"],
    [undefined, "high"]
  ])("gpt-image quality %s → %s", (quality, sent) => {
    expect(GPT.body({ ...input, quality })).toMatchObject({ quality: sent });
  });
});

describe("promptWithNegative", () => {
  it("appends the negative prompt as an Avoid line", () => {
    expect(promptWithNegative("hero", "blur")).toBe("hero\n\nAvoid: blur");
  });

  it("keeps the prompt as is without a negative", () => {
    expect(promptWithNegative("hero", undefined)).toBe("hero");
    expect(promptWithNegative("hero", "")).toBe("hero");
  });
});
