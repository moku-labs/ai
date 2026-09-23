import { describe, expect, it } from "vitest";
import { imageSize } from "../../image-size";
import { jpegHeader, pngHeader, webpHeader } from "./fixtures";

describe("imageSize", () => {
  it("reads a PNG IHDR", () => {
    expect(imageSize(pngHeader(1024, 576))).toEqual({ width: 1024, height: 576 });
  });

  it("reads a JPEG SOF after EXIF and DQT segments", () => {
    expect(imageSize(jpegHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it("reads WebP VP8, VP8L and VP8X headers", () => {
    expect(imageSize(webpHeader("VP8 ", 768, 1024))).toEqual({ width: 768, height: 1024 });
    expect(imageSize(webpHeader("VP8L", 1000, 400))).toEqual({ width: 1000, height: 400 });
    expect(imageSize(webpHeader("VP8X", 2048, 2048))).toEqual({ width: 2048, height: 2048 });
  });

  it("skips JPEG fill bytes and standalone markers before the SOF", () => {
    const sof = [
      0xff, 0xc0, 0, 17, 8, 0x02, 0x40, 0x04, 0x00, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1
    ];
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0xd0, ...sof]);
    expect(imageSize(bytes)).toEqual({ width: 1024, height: 576 });
  });

  it("returns undefined for a WebP whose first chunk carries no size", () => {
    const riff = [0x52, 0x49, 0x46, 0x46, 12, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
    const alph = [0x41, 0x4c, 0x50, 0x48, 0, 0, 0, 0];
    expect(imageSize(new Uint8Array([...riff, ...alph]))).toBeUndefined();
  });

  it("returns undefined for other bytes, a JPEG without SOF, or a zero side", () => {
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeUndefined();
    expect(imageSize(pngHeader(0, 10))).toBeUndefined();
  });
});
