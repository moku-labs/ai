import { describe, expect, it } from "vitest";
import type { SpriteRequest } from "../../../sprite/contract";
import { TerminalProviderError } from "../../errors";
import { mergePrices } from "../../prices";
import {
  BIREFNET_RESOLUTIONS,
  BIREFNET_VARIANTS,
  checkSpriteRequest,
  resolveSpriteModel,
  spriteAliases
} from "../../sprite/models";
import { spritePriceOf, spritePrices } from "../../sprite/prices";

// ─────────────────────────────────────────────────────────────────────────────
// fal sprite catalog: aliases, request validation, the BiRefNet body, prices.
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE = { path: "/store/ab/raw.png", mimeType: "image/png", hash: "abcd" };
const REQUEST: SpriteRequest = { source: SOURCE, model: "birefnet" };

/** The error `checkSpriteRequest` throws for `request`. */
function errorOf(request: unknown): unknown {
  try {
    // A runtime shape the type system would refuse: the zod schema is the guard under test.
    checkSpriteRequest(request as SpriteRequest);
  } catch (error) {
    return error;
  }
  throw new Error("expected checkSpriteRequest to throw");
}

describe("catalog", () => {
  it("lists birefnet, then none", () => {
    expect(spriteAliases()).toEqual(["birefnet", "none"]);
  });

  it("maps birefnet to the fal BiRefNet v2 endpoint and none to no endpoint", () => {
    expect(resolveSpriteModel("birefnet")).toMatchObject({
      alias: "birefnet",
      endpoint: "fal-ai/birefnet/v2"
    });
    expect(resolveSpriteModel("none")).toEqual({ alias: "none" });
  });

  it("rejects an unknown alias with a terminal 400 listing the aliases", () => {
    expect(() => resolveSpriteModel("rembg")).toThrow(
      '[ai] Unknown fal sprite model "rembg".\n  Use one of: birefnet, none.'
    );
    expect(errorOf({ ...REQUEST, model: "rembg" })).toMatchObject({
      name: "TerminalProviderError",
      status: 400
    });
  });

  it("documents the BiRefNet variants and resolutions", () => {
    expect(BIREFNET_VARIANTS).toEqual([
      "General Use (Light)",
      "General Use (Light 2K)",
      "General Use (Heavy)",
      "Matting",
      "Portrait",
      "General Use (Dynamic)"
    ]);
    expect(BIREFNET_RESOLUTIONS).toEqual(["1024x1024", "2048x2048", "2304x2304"]);
  });
});

describe("validation", () => {
  it.each([
    ["a $ref", { $ref: "btn-raw" }],
    ["a $file", { $file: "art/raw.png" }],
    ["a file without a hash", { path: "/a.png", mimeType: "image/png" }],
    ["nothing", undefined]
  ])("refuses %s as the source, with a terminal 400", (_label, source) => {
    expect(errorOf({ ...REQUEST, source })).toMatchObject({
      name: "TerminalProviderError",
      status: 400,
      message:
        "[ai] fal sprite got an unresolved source.\n  Run the item through app.runner, or pass a { path, mimeType, hash } file."
    });
  });

  it.each([
    ["trim", { trim: "yes" }],
    ["padding", { padding: -1 }],
    ["padding", { padding: 1.5 }],
    ["size.width", { size: { width: 0, height: 16 } }],
    ["size.height", { size: { width: 16, height: 2.5 } }],
    ["fit", { fit: "stretch" }],
    ["pixelArt", { pixelArt: 1 }],
    ["alphaThreshold", { alphaThreshold: 256 }],
    ["params", { params: "loud" }],
    ["params.model", { params: { model: "General Use (Huge)" } }],
    ["params.operating_resolution", { params: { operating_resolution: "4096x4096" } }]
  ])("names %s in the terminal 400", (field, extra) => {
    const error = errorOf({ ...REQUEST, ...extra });
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({ status: 400 });
    const { message } = error as Error;
    expect(message.startsWith(`[ai] Invalid sprite request: ${field} `)).toBe(true);
    expect(message.endsWith(".\n  Fix the build item that produced it.")).toBe(true);
  });

  it("does not read the matte params of none", () => {
    const checked = checkSpriteRequest({
      ...REQUEST,
      model: "none",
      params: { model: "General Use (Huge)" }
    });
    expect(checked.model).toEqual({ alias: "none" });
    expect(checked.params).toEqual({});
  });

  it("returns the source and the matte params of a valid request", () => {
    const checked = checkSpriteRequest({
      ...REQUEST,
      padding: 2,
      size: { width: 128, height: 64 },
      fit: "cover",
      params: { model: "Matting", operating_resolution: "2048x2048", seed: 7 }
    });
    expect(checked.source).toEqual(SOURCE);
    expect(checked.params).toEqual({ model: "Matting", operating_resolution: "2048x2048" });
  });
});

describe("body", () => {
  it("sends the light model at 1024x1024 as a refined png by default", () => {
    const { model, params } = checkSpriteRequest(REQUEST);
    if (model.alias === "none") throw new Error("expected a matte model");
    expect(model.body("https://cdn.fal.test/file/raw.png", params)).toEqual({
      image_url: "https://cdn.fal.test/file/raw.png",
      model: "General Use (Light)",
      operating_resolution: "1024x1024",
      output_format: "png",
      refine_foreground: true
    });
  });

  it("passes params.model and params.operating_resolution through", () => {
    const { model, params } = checkSpriteRequest({
      ...REQUEST,
      params: { model: "General Use (Heavy)", operating_resolution: "2304x2304" }
    });
    if (model.alias === "none") throw new Error("expected a matte model");
    expect(model.body("u", params)).toMatchObject({
      model: "General Use (Heavy)",
      operating_resolution: "2304x2304"
    });
  });
});

describe("prices", () => {
  it("bundles birefnet at $0.002 per image under sprite:, and none at 0", () => {
    expect(spritePrices.birefnet).toBe(0.002);
    expect(mergePrices({})["sprite:birefnet"]).toBe(0.002);
    expect(spritePriceOf(mergePrices({}), "birefnet")).toBe(0.002);
    expect(spritePriceOf({}, "none")).toBe(0);
  });

  it("takes an override and throws a terminal 400 for a missing row", () => {
    expect(spritePriceOf(mergePrices({ "sprite:birefnet": 0.005 }), "birefnet")).toBe(0.005);
    expect(() => spritePriceOf({}, "birefnet")).toThrow(
      '[ai] No price for fal sprite model "birefnet".\n  Add it to fal.priceOverrides.'
    );
  });
});
