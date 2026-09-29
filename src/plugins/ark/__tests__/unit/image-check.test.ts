import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkAssetImage,
  imageSize,
  MAX_ASSET_IMAGE_BYTES,
  readAssetImage
} from "../../image-check";
import type { TempFiles } from "../fixtures";
import { createTempFiles, jpegHeader, pngHeader, webpHeader } from "../fixtures";

let temp: TempFiles;

beforeAll(() => {
  temp = createTempFiles();
});

afterAll(() => {
  temp.cleanup();
});

describe("imageSize", () => {
  it("reads PNG, JPEG and every WebP chunk kind", () => {
    expect(imageSize(pngHeader(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(imageSize(jpegHeader(800, 1200))).toEqual({ width: 800, height: 1200 });
    expect(imageSize(webpHeader("VP8 ", 640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageSize(webpHeader("VP8L", 640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageSize(webpHeader("VP8X", 640, 480))).toEqual({ width: 640, height: 480 });
  });

  it("returns undefined for another format or a damaged header", () => {
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(imageSize(pngHeader(0, 10))).toBeUndefined();
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00]))).toBeUndefined();
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0, 0]))).toBeUndefined();
  });

  it("skips fill bytes and standalone markers before the JPEG frame", () => {
    const header = jpegHeader(400, 500);
    const padded = new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0xd0, ...header.subarray(2)]);
    expect(imageSize(padded)).toEqual({ width: 400, height: 500 });
  });

  it("returns undefined for a WebP with an unknown first chunk", () => {
    const bytes = webpHeader("VP8X", 10, 10);
    bytes.set([0x41, 0x4c, 0x50, 0x48], 12);
    expect(imageSize(bytes)).toBeUndefined();
  });
});

describe("checkAssetImage", () => {
  it("passes a PNG, a JPEG and a WebP inside the limits and returns the size", () => {
    expect(checkAssetImage(pngHeader(1024, 1024), "image/png", "mira.png")).toEqual({
      width: 1024,
      height: 1024
    });
    expect(checkAssetImage(jpegHeader(300, 750), "image/jpeg", "a.jpg")).toEqual({
      width: 300,
      height: 750
    });
    expect(checkAssetImage(webpHeader("VP8 ", 6000, 2400), "image/webp", "b.webp")).toEqual({
      width: 6000,
      height: 2400
    });
  });

  it("rejects another MIME type", () => {
    expect(() => checkAssetImage(pngHeader(1024, 1024), "image/gif", "mira.gif")).toThrow(
      '[ai] ark asset image "mira.gif" is image/gif.\n  Use a PNG, JPEG or WebP file.'
    );
  });

  it("rejects a file of 30 MB or more", () => {
    const bytes = new Uint8Array(MAX_ASSET_IMAGE_BYTES);
    bytes.set(pngHeader(1024, 1024));
    expect(() => checkAssetImage(bytes, "image/png", "big.png")).toThrow(
      '[ai] ark asset image "big.png" is 30.0 MB; it must be under 30 MB.\n  Use a smaller file.'
    );
  });

  it("rejects an unreadable header", () => {
    expect(() => checkAssetImage(new Uint8Array([1, 2, 3]), "image/png", "x.png")).toThrow(
      '[ai] ark cannot read the image size of "x.png".\n  Use a PNG, JPEG or WebP file.'
    );
  });

  it("rejects a side under 300 or over 6000 px", () => {
    expect(() => checkAssetImage(pngHeader(299, 400), "image/png", "s.png")).toThrow(
      '[ai] ark asset image "s.png" is 299x400 px; each side must be 300 to 6000 px.\n  Resize the image.'
    );
    expect(() => checkAssetImage(pngHeader(6001, 6000), "image/png", "l.png")).toThrow(
      "is 6001x6000 px; each side must be 300 to 6000 px."
    );
  });

  it("rejects a width/height ratio outside 0.4 to 2.5", () => {
    expect(() => checkAssetImage(pngHeader(2600, 1000), "image/png", "w.png")).toThrow(
      '[ai] ark asset image "w.png" has a width/height ratio of 2.60; it must be 0.4 to 2.5.\n  Crop the image.'
    );
    expect(() => checkAssetImage(pngHeader(390, 1000), "image/png", "t.png")).toThrow(
      "ratio of 0.39; it must be 0.4 to 2.5."
    );
  });
});

describe("readAssetImage", () => {
  it("reads the file bytes", async () => {
    const file = temp.file("face.png", pngHeader(512, 512), "image/png");
    expect(await readAssetImage(file)).toEqual(pngHeader(512, 512));
  });

  it("throws a two-line error for a missing file", async () => {
    const missing = { path: `${temp.dir}/missing.png`, mimeType: "image/png", hash: "h" };
    await expect(readAssetImage(missing)).rejects.toThrow(
      `[ai] Cannot read ark asset image "${missing.path}".\n  Check that the $ref or $file it came from still exists.`
    );
  });
});
