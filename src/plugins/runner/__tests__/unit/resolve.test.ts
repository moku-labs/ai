import { describe, expect, it } from "vitest";
import {
  extensionOfMimeType,
  imageMimeTypeOfBytes,
  mimeTypeOfFile,
  mimeTypeOfPath,
  normalizeOutputs,
  normalizeResult,
  OCTET_STREAM,
  resolveReferences
} from "../../resolve";
import type { ResolvedFile } from "../../types";

/** The journal's nullable mime type column, as the runner reads it. */
// eslint-disable-next-line unicorn/no-null -- ItemRow.mimeType is `string | null`, matching the SQL column
const NO_MIME = null;

const KEYFRAME: ResolvedFile = { path: "/store/ab/abcd", mimeType: "image/png", hash: "abcd" };
const SHEET: ResolvedFile = { path: "/repo/refs/akari.png", mimeType: "image/png", hash: "ef01" };

describe("mimeTypeOfPath", () => {
  it.each([
    ["a.png", "image/png"],
    ["a.JPG", "image/jpeg"],
    ["clip.mp4", "video/mp4"],
    ["line.wav", "audio/wav"],
    ["notes", OCTET_STREAM],
    ["x.unknown", OCTET_STREAM]
  ])("maps %s to %s", (file, mime) => {
    expect(mimeTypeOfPath(file)).toBe(mime);
  });

  it("keeps a .json $file as plain JSON, never an asset record", () => {
    expect(mimeTypeOfPath("x.json")).toBe("application/json");
  });
});

describe("imageMimeTypeOfBytes", () => {
  it.each<[string, string | undefined, number[]]>([
    ["PNG", "image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]],
    ["JPEG", "image/jpeg", [0xff, 0xd8, 0xff, 0xdb]],
    ["GIF", "image/gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
    ["WEBP", "image/webp", [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]],
    ["RIFF WAVE", undefined, [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]],
    ["a cut JPEG", undefined, [0xff, 0xd8]],
    ["empty", undefined, []]
  ])("reads %s bytes as %s", (_name, mime, bytes) => {
    expect(imageMimeTypeOfBytes(new Uint8Array(bytes))).toBe(mime);
  });
});

describe("mimeTypeOfFile", () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

  it("lets the signature win over the extension and names the mismatch", () => {
    expect(mimeTypeOfFile("/refs/akari.PNG", JPEG)).toEqual({
      mimeType: "image/jpeg",
      mismatch: { extension: "png", detected: "image/jpeg" }
    });
  });

  it("names no mismatch when the signature and the extension agree", () => {
    const result = mimeTypeOfFile("/refs/akari.jpeg", JPEG);
    expect(result).toEqual({ mimeType: "image/jpeg" });
    expect(result).not.toHaveProperty("mismatch");
  });

  it("keeps the extension map for bytes with no image signature", () => {
    expect(mimeTypeOfFile("/voice/line.mp3", new Uint8Array([0x49, 0x44, 0x33]))).toEqual({
      mimeType: "audio/mpeg"
    });
  });
});

describe("extensionOfMimeType", () => {
  it.each<[string | null, string]>([
    ["video/mp4", "mp4"],
    ["image/jpeg", "jpg"],
    ["text/plain; charset=utf-8", "txt"],
    ["application/x-custom", "bin"],
    [NO_MIME, "bin"]
  ])("maps %s to .%s", (mime, extension) => {
    expect(extensionOfMimeType(mime)).toBe(extension);
  });

  it("exports an asset record as .json, not .bin", () => {
    expect(extensionOfMimeType("application/vnd.moku.asset+json")).toBe("json");
  });
});

describe("resolveReferences", () => {
  it("replaces $ref and $file values at any depth and copies the rest", () => {
    const request = {
      prompt: "p",
      image: { $ref: "key" },
      refs: [{ $file: "refs/akari.png" }, "plain"],
      params: { seed: 1 }
    };

    expect(
      resolveReferences(request, new Map([["key", KEYFRAME]]), new Map([["refs/akari.png", SHEET]]))
    ).toEqual({ prompt: "p", image: KEYFRAME, refs: [SHEET, "plain"], params: { seed: 1 } });
  });

  it("throws when a reference was never planned", () => {
    expect(() => resolveReferences({ image: { $ref: "ghost" } }, new Map(), new Map())).toThrow(
      /Unresolved \$ref "ghost"/
    );
  });
});

describe("normalizeResult", () => {
  it("takes bytes from body, audio, image or video with their mime type", () => {
    const bytes = new Uint8Array([1]);
    expect(normalizeResult({ video: bytes, mimeType: "video/mp4", costUsd: 1 })).toEqual({
      bytes,
      mimeType: "video/mp4"
    });
    expect(normalizeResult({ body: bytes, costUsd: 0 }).mimeType).toBe(OCTET_STREAM);
  });

  it("encodes text results as UTF-8 text/plain", () => {
    const { bytes, mimeType } = normalizeResult({ text: "こんにちは", costUsd: 0 });
    expect(new TextDecoder().decode(bytes)).toBe("こんにちは");
    expect(mimeType).toBe("text/plain; charset=utf-8");
  });

  it("throws a terminal (hint-less) error when there is no content", () => {
    expect(() => normalizeResult({ costUsd: 0 })).toThrow(/Handler result has no content/);
  });
});

describe("normalizeOutputs", () => {
  const FIRST = new Uint8Array([1]);
  const SECOND = new Uint8Array([2]);
  const THIRD = new Uint8Array([3]);

  it("is undefined for a result without images, or with an empty list", () => {
    expect(normalizeOutputs({ image: FIRST, mimeType: "image/png", costUsd: 0 })).toBeUndefined();
    expect(normalizeOutputs({ image: FIRST, images: [], costUsd: 0 })).toBeUndefined();
  });

  it("lists every image in order with its mime type", () => {
    const result = {
      image: FIRST,
      mimeType: "image/jpeg",
      images: [
        { image: FIRST, mimeType: "image/jpeg" },
        { image: SECOND, mimeType: "image/png" },
        { image: THIRD, mimeType: "image/webp" }
      ],
      costUsd: 0.105
    };

    expect(normalizeOutputs(result)).toEqual([
      { bytes: FIRST, mimeType: "image/jpeg" },
      { bytes: SECOND, mimeType: "image/png" },
      { bytes: THIRD, mimeType: "image/webp" }
    ]);
  });

  it("keeps a group of one, so the caller sees the count", () => {
    const result = { images: [{ image: FIRST, mimeType: "image/jpeg" }], costUsd: 0.035 };

    expect(normalizeOutputs(result)).toEqual([{ bytes: FIRST, mimeType: "image/jpeg" }]);
  });

  it("falls back to application/octet-stream for an empty mime type", () => {
    const result = { images: [{ image: FIRST, mimeType: "" }], costUsd: 0 };

    expect(normalizeOutputs(result)).toEqual([{ bytes: FIRST, mimeType: OCTET_STREAM }]);
  });
});
