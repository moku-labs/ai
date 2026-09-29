import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyImages, extensionForMime } from "../../prompt/files";

describe("extensionForMime", () => {
  it("maps png, jpeg and webp, and copies anything else as png", () => {
    expect(extensionForMime("image/png")).toBe("png");
    expect(extensionForMime("image/jpeg")).toBe("jpg");
    expect(extensionForMime("image/webp")).toBe("webp");
    expect(extensionForMime("image/tiff")).toBe("png");
  });
});

describe("copyImages", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "moku-claude-files-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("copies each image as image-<n>.<ext> and returns the file names in order", async () => {
    const png = path.join(root, "a");
    const jpg = path.join(root, "b");
    writeFileSync(png, "png-bytes");
    writeFileSync(jpg, "jpg-bytes");
    const dir = path.join(root, "call");
    mkdirSync(dir);

    const names = await copyImages(
      [
        { path: png, mimeType: "image/png", hash: "h1" },
        { path: jpg, mimeType: "image/jpeg", hash: "h2" }
      ],
      dir
    );

    expect(names).toEqual(["image-1.png", "image-2.jpg"]);
    expect(readdirSync(dir).toSorted()).toEqual(["image-1.png", "image-2.jpg"]);
    expect(readFileSync(path.join(dir, "image-2.jpg"), "utf8")).toBe("jpg-bytes");
  });

  it("returns no names for no images", async () => {
    expect(await copyImages([], root)).toEqual([]);
  });
});
