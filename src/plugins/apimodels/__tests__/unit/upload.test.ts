import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { VideoFile } from "../../../video/contract";
import { RetryableProviderError, TerminalProviderError } from "../../types";
import { fileNameOf, mapInSlots, SLOTS, uploadFiles, uploadKey } from "../../upload";
import type { TempFiles } from "./fixtures";
import {
  BASE,
  createTempFiles,
  createTestCtx,
  envelope,
  jsonResponse,
  publicUrlOf,
  rejectionOf,
  sleep,
  stubApi,
  TEST_KEY
} from "./fixtures";

const OPTIONS = { apiKey: TEST_KEY };

let temp: TempFiles;
let png: VideoFile;
let jpg: VideoFile;

beforeAll(() => {
  temp = createTempFiles();
  png = temp.file("anna.png", new Uint8Array([137, 80, 78, 71]), "image/png", "a".repeat(64));
  jpg = temp.file("ben.jpg", new Uint8Array([255, 216]), "image/jpeg", "b".repeat(64));
});

afterAll(() => {
  temp.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The `file` field of a recorded multipart body. */
function fileOf(body: RequestInit["body"]): File {
  return (body as FormData).get("file") as File;
}

describe("fileNameOf / uploadKey", () => {
  it("names the file by 16 hash characters and an extension from the MIME type", () => {
    expect(fileNameOf(png)).toBe(`${"a".repeat(16)}.png`);
    expect(
      fileNameOf({ path: "/x/voice.flac", mimeType: "audio/flac", hash: "c".repeat(64) })
    ).toBe(`${"c".repeat(16)}.flac`);
    expect(fileNameOf({ path: "/x/blob", mimeType: "application/x", hash: "d".repeat(64) })).toBe(
      `${"d".repeat(16)}.bin`
    );
  });

  it("keys the cache by MIME type and the hash as delivered", () => {
    expect(uploadKey(png)).toBe(`file:image/png:${"a".repeat(64)}`);
  });
});

describe("uploadFiles", () => {
  it("POSTs each file as multipart field `file` with the Bearer key and returns publicUrl", async () => {
    const api = stubApi();

    const urls = await uploadFiles(createTestCtx(), [png, jpg], OPTIONS);

    expect(urls).toEqual([publicUrlOf(fileNameOf(png)), publicUrlOf(fileNameOf(jpg))]);
    // Uploads run in parallel, so find the png's call by its file name.
    const call = api.calls("upload").find(upload => fileOf(upload.body).name === fileNameOf(png));
    expect(call?.url).toBe(`${BASE}/files`);
    expect(call?.method).toBe("POST");
    expect(call?.headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
    const sent = fileOf(call?.body);
    expect(sent.type).toBe("image/png");
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  it("uploads a file once per process: the second call hits state.uploads", async () => {
    const api = stubApi();
    const ctx = createTestCtx();

    await uploadFiles(ctx, [png], OPTIONS);
    const again = await uploadFiles(ctx, [png], OPTIONS);

    expect(api.count("upload")).toBe(1);
    expect(again).toEqual([publicUrlOf(fileNameOf(png))]);
    expect(ctx.state.uploads.get(uploadKey(png))).toBe(publicUrlOf(fileNameOf(png)));
  });

  it("uses the delivered hash, never recomputed: other bytes under the same hash are a cache hit", async () => {
    const api = stubApi();
    const ctx = createTestCtx();
    const sameHash = temp.file("other.png", new Uint8Array([9, 9, 9]), "image/png", png.hash);

    await uploadFiles(ctx, [png], OPTIONS);
    await uploadFiles(ctx, [sameHash], OPTIONS);

    expect(api.count("upload")).toBe(1);
  });

  it("uploads the same file named twice in one call once", async () => {
    const api = stubApi();
    const urls = await uploadFiles(createTestCtx(), [png, jpg, png], OPTIONS);
    expect(api.count("upload")).toBe(2);
    expect(urls[0]).toBe(urls[2]);
  });

  it(`runs at most ${SLOTS} uploads at once, and keeps the input order`, async () => {
    let active = 0;
    let peak = 0;
    stubApi({
      upload: async (_n, form) => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(15);
        active -= 1;
        return envelope({ publicUrl: publicUrlOf((form.get("file") as File).name) });
      }
    });
    const files = Array.from({ length: 9 }, (_, index) =>
      temp.file(`ref${index}.png`, new Uint8Array([index]), "image/png", String(index).repeat(64))
    );

    const urls = await uploadFiles(createTestCtx(), files, OPTIONS);

    expect(peak).toBe(4);
    expect(urls).toEqual(files.map(file => publicUrlOf(fileNameOf(file))));
  });

  it("waits Retry-After once on a 429 inside the loop, then succeeds", async () => {
    const api = stubApi({
      upload: (n, form) =>
        n === 1
          ? jsonResponse(429, { code: 429 }, { "retry-after": "0" })
          : envelope({ publicUrl: publicUrlOf((form.get("file") as File).name) })
    });

    const urls = await uploadFiles(createTestCtx(), [png], OPTIONS);

    expect(urls).toEqual([publicUrlOf(fileNameOf(png))]);
    expect(api.count("upload")).toBe(2);
  });

  it("throws the second 429 as retryable", async () => {
    stubApi({ upload: () => jsonResponse(429, { code: 429 }, { "retry-after": "0" }) });
    const error = await rejectionOf(() => uploadFiles(createTestCtx(), [png], OPTIONS));
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ status: 429 });
  });

  it("throws a terminal error when the response has no publicUrl", async () => {
    stubApi({ upload: () => envelope({}) });
    const error = await rejectionOf(() => uploadFiles(createTestCtx(), [png], OPTIONS));
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toBe(
      "[ai] apimodels returned an incomplete upload response.\n  Expected data.publicUrl; check the apimodels API for a change."
    );
  });

  it("throws a terminal error when an input file cannot be read, before any fetch", async () => {
    const api = stubApi();
    const missing: VideoFile = {
      path: `${temp.dir}/gone.png`,
      mimeType: "image/png",
      hash: "e".repeat(64)
    };

    const error = await rejectionOf(() => uploadFiles(createTestCtx(), [missing], OPTIONS));

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toBe(
      `[ai] Cannot read apimodels input file "${missing.path}".\n  Check that the $ref or $file it came from still exists.`
    );
    expect(api.count("upload")).toBe(0);
  });
});

describe("mapInSlots", () => {
  it("keeps item order", async () => {
    expect(await mapInSlots([3, 1, 2], 2, async n => n * 10)).toEqual([30, 10, 20]);
  });

  it("starts no new item after a failure and waits for running ones before rejecting", async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const failure = new Error("boom");

    const error = await rejectionOf(() =>
      mapInSlots([1, 2, 3, 4, 5], 2, async n => {
        started.push(n);
        if (n === 1) throw failure;
        await sleep(10);
        finished.push(n);
        return n;
      })
    );

    expect(error).toBe(failure);
    expect(started).toEqual([1, 2]);
    expect(finished).toEqual([2]);
  });
});
