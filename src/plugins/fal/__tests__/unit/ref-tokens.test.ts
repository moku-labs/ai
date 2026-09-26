import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VideoFile, VideoRequest } from "../../../video/contract";
import { videoCostUsd } from "../../prices";
import type { EstimateInput, EstimateRequest } from "../../types";
import { createVideoHandler } from "../../video/handler";
import type { TempFiles } from "./fixtures";
import { createTempFiles, createTestCtx, jpegHeader, pngHeader, webpHeader } from "./fixtures";

const MODEL = "minimax-h3-max-ref";
/** 5 s at 768P, before any reference surcharge. */
const BASE_768P = 0.4;

let temp: TempFiles;
let square: VideoFile;
let wide: VideoFile;
let threeByTwo: VideoFile;
let voice: VideoFile;

beforeAll(() => {
  temp = createTempFiles();
  square = temp.file("square.png", pngHeader(1024, 1024), "image/png", "a".repeat(64));
  wide = temp.file("wide.jpg", jpegHeader(1024, 576), "image/jpeg", "b".repeat(64));
  threeByTwo = temp.file("3x2.webp", webpHeader("VP8X", 1200, 800), "image/webp", "c".repeat(64));
  voice = temp.file("voice.mp3", new Uint8Array([0xff, 0xfb]), "audio/mpeg", "d".repeat(64));
});

afterAll(() => {
  temp.cleanup();
});

/** Cost of an H3 Max request with the given first frame and refs. */
function cost(
  image: EstimateInput | undefined,
  refs: EstimateInput[],
  extra: Partial<VideoRequest> = {}
): number {
  const request: EstimateRequest = { model: MODEL, prompt: "p", refs, ...extra };
  if (image !== undefined) request.image = image;
  return videoCostUsd(createTestCtx(), request);
}

describe("minimax-h3-max-ref reference tokens", () => {
  it("prices output per resolution", () => {
    expect(cost(square, [], { resolution: "480P" })).toBe(0.25);
    expect(cost(square, [])).toBe(BASE_768P);
    expect(cost(square, [], { resolution: "1080P" })).toBe(0.8);
  });

  it("includes four square images in the allowance and bills the fifth (1024 tokens = $0.02048)", () => {
    expect(cost(square, [square, square, square])).toBe(BASE_768P);
    expect(cost(square, [square, square, square, square])).toBe(0.420_48);
  });

  it("sizes images by aspect ratio from their headers", () => {
    // 4 x 16:9 = 7296 tokens, 3200 over the allowance.
    expect(cost(wide, [wide, wide, wide])).toBe(0.464);
    // 3:2 maps up to the 16:9 row.
    expect(cost(threeByTwo, [threeByTwo, threeByTwo, threeByTwo])).toBe(0.464);
  });

  it("counts unresolved and unreadable images at the 2560-token worst case", () => {
    const unresolved: EstimateInput = { $ref: "face" };
    const missing: VideoFile = { path: `${temp.dir}/gone.png`, mimeType: "image/png", hash: "e" };
    const notAnImage = temp.file(
      "junk.png",
      new Uint8Array([1, 2, 3]),
      "image/png",
      "f".repeat(64)
    );

    expect(cost(unresolved, [unresolved])).toBe(0.420_48);
    expect(cost(missing, [notAnImage])).toBe(0.420_48);
  });

  it("adds 1200 tokens once for any audio refs", () => {
    expect(cost(square, [square, square, square, voice])).toBe(0.424);
    expect(cost(square, [voice, voice])).toBe(BASE_768P);
  });

  it("takes the allowance and rate from priceOverrides", () => {
    const ctx = createTestCtx({
      config: {
        priceOverrides: { [`${MODEL}#refTokensIncluded`]: 0, [`${MODEL}#refTokenUsdPer1k`]: 0.01 }
      }
    });
    expect(videoCostUsd(ctx, { model: MODEL, prompt: "p", image: square })).toBe(0.410_24);
  });

  it("leaves models without a token rate unchanged", () => {
    expect(
      videoCostUsd(createTestCtx(), {
        model: "kling-o3-ref",
        prompt: "p",
        image: wide,
        refs: [wide]
      })
    ).toBe(0.56);
  });

  it("estimate and actual cost agree", () => {
    const request: VideoRequest = {
      model: MODEL,
      prompt: "p",
      image: wide,
      refs: [wide, wide, wide, voice]
    };
    const handler = createVideoHandler(createTestCtx());
    expect(handler.estimate(request).usd).toBe(videoCostUsd(createTestCtx(), request));
  });
});
