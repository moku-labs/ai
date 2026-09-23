import { describe, expect, it } from "vitest";
import {
  extensionOfMimeType,
  mimeTypeOfPath,
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
