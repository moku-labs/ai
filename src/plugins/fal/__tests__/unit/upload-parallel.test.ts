import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { VideoFile } from "../../../video/contract";
import { fileNameOf, toDataUri, uploadInputs } from "../../upload";
import type { TempFiles } from "./fixtures";
import {
  callsOf,
  createTempFiles,
  createTestCtx,
  DEFAULT_CONFIG,
  initiateCount,
  jsonBodyOf,
  jsonResponse,
  okResponse,
  storageUrlOf,
  stubFetch,
  stubStorageFetch,
  TEST_KEY
} from "./fixtures";

const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const JPG = new Uint8Array([255, 216, 255, 9]);
const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
const NO_REFS = { images: [], audio: [], videos: [] };
const OPTIONS = { apiKey: TEST_KEY };

let temp: TempFiles;
let png: VideoFile;
let jpg: VideoFile;
let mp4: VideoFile;
let refs: VideoFile[];

beforeAll(() => {
  temp = createTempFiles();
  png = temp.file("key.png", PNG, "image/png", "a".repeat(64));
  jpg = temp.file("face.jpg", JPG, "image/jpeg", "b".repeat(64));
  mp4 = temp.file("tail.mp4", MP4, "video/mp4", "c".repeat(64));
  refs = [1, 2, 3, 4, 5, 6].map(n =>
    temp.file(`ref${n}.png`, new Uint8Array([n]), "image/png", String(n).repeat(64))
  );
});

afterAll(() => {
  temp.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/** A storage stub where every call takes `delayMs`; tracks how many uploads run at once. */
function stubSlowStorage(delayMs: number): {
  fetchMock: ReturnType<typeof vi.fn>;
  peak: () => number;
} {
  let active = 0;
  let peak = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === DEFAULT_CONFIG.uploadUrl) {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(delayMs);
      const { file_name: fileName } = JSON.parse(String(init?.body)) as { file_name: string };
      return jsonResponse(200, {
        upload_url: `https://upload.fal.test/put/${fileName}`,
        file_url: `https://cdn.fal.test/file/${fileName}`
      });
    }
    await sleep(delayMs);
    active -= 1;
    return okResponse();
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, peak: () => peak };
}

/** The file names the storage initiates of `fetchMock` asked for, in call order. */
function initiatedNames(fetchMock: ReturnType<typeof vi.fn>): unknown[] {
  return callsOf(fetchMock)
    .filter(call => call.url === DEFAULT_CONFIG.uploadUrl)
    .map(call => jsonBodyOf(call).file_name);
}

describe("uploadInputs — video refs", () => {
  it("uploads video refs to fal storage and returns them as videoRefs", async () => {
    stubStorageFetch();

    const urls = await uploadInputs(
      createTestCtx(),
      png,
      { images: [jpg], audio: [], videos: [mp4] },
      OPTIONS
    );

    expect(urls).toEqual({
      image: storageUrlOf(png),
      refs: [storageUrlOf(jpg)],
      audioRefs: [],
      videoRefs: [storageUrlOf(mp4)]
    });
  });

  it("inlines video refs as data URIs in data-uri mode", async () => {
    const fetchMock = stubFetch();

    const urls = await uploadInputs(
      createTestCtx({ config: { upload: "data-uri" } }),
      png,
      { images: [], audio: [], videos: [mp4] },
      OPTIONS
    );

    expect(urls.videoRefs).toEqual([toDataUri(MP4, "video/mp4")]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("uploadInputs — parallel refs", () => {
  it("uploads the first frame before any ref", async () => {
    const { fetchMock } = stubSlowStorage(2);

    await uploadInputs(createTestCtx(), png, { ...NO_REFS, images: refs }, OPTIONS);

    const calls = callsOf(fetchMock);
    expect(jsonBodyOf(calls[0]).file_name).toBe(fileNameOf(png));
    expect(calls[1]?.url).toBe(`https://upload.fal.test/put/${fileNameOf(png)}`);
  });

  it("uploads refs in parallel, at most 4 at a time, and keeps their order", async () => {
    const { peak } = stubSlowStorage(10);

    const urls = await uploadInputs(
      createTestCtx(),
      png,
      { images: refs.slice(0, 3), audio: [], videos: refs.slice(3) },
      OPTIONS
    );

    expect(peak()).toBe(4);
    expect(urls.refs).toEqual(refs.slice(0, 3).map(file => storageUrlOf(file)));
    expect(urls.videoRefs).toEqual(refs.slice(3).map(file => storageUrlOf(file)));
  });

  it("logs the fallback once when parallel uploads fail together", async () => {
    let initiates = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url !== DEFAULT_CONFIG.uploadUrl) return okResponse();
        initiates += 1;
        if (initiates === 1) {
          return jsonResponse(200, { upload_url: "https://upload.fal.test/put/1", file_url: "u1" });
        }
        await sleep(10); // both ref initiates are in flight before either fails
        return jsonResponse(500, { detail: "down" });
      })
    );
    const ctx = createTestCtx();

    const urls = await uploadInputs(
      ctx,
      png,
      { ...NO_REFS, images: [jpg], videos: [mp4] },
      OPTIONS
    );

    expect(urls).toEqual({
      image: "u1",
      refs: [toDataUri(JPG, "image/jpeg")],
      audioRefs: [],
      videoRefs: [toDataUri(MP4, "video/mp4")]
    });
    expect(initiates).toBe(3);
    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
    expect(ctx.log.warn).toHaveBeenCalledWith("fal:upload:fallback", { status: 500 });
  });

  it("starts no new upload after a ref fails", async () => {
    const { fetchMock } = stubSlowStorage(10);
    const missing = {
      path: `${temp.dir}/missing.png`,
      mimeType: "image/png",
      hash: "f".repeat(64)
    };

    await expect(
      uploadInputs(createTestCtx(), png, { ...NO_REFS, images: [missing, ...refs] }, OPTIONS)
    ).rejects.toThrow(/^\[ai\] Cannot read fal input file/);

    // The three uploads already running finish; the refs behind them never start.
    await vi.waitFor(() => {
      expect(callsOf(fetchMock).filter(call => call.method === "PUT")).toHaveLength(4);
    });
    expect(initiatedNames(fetchMock)).toEqual(
      expect.not.arrayContaining(refs.slice(3).map(file => fileNameOf(file)))
    );
    expect(initiateCount(fetchMock)).toBe(4);
  });
});

describe("uploadInputs — upload cache", () => {
  it("sends a file uploaded before by its cached URL, without any fetch", async () => {
    const ctx = createTestCtx();
    stubStorageFetch();
    const first = await uploadInputs(ctx, png, { ...NO_REFS, videos: [mp4] }, OPTIONS);

    const fetchMock = stubStorageFetch();
    const second = await uploadInputs(ctx, png, { ...NO_REFS, videos: [mp4] }, OPTIONS);

    expect(second).toEqual(first);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keys the cache by storage mode, MIME type and content sha256", async () => {
    const ctx = createTestCtx();
    stubStorageFetch();
    await uploadInputs(ctx, png, NO_REFS, OPTIONS);

    const sha256 = createHash("sha256").update(PNG).digest("hex");
    expect([...ctx.state.uploads.entries()]).toEqual([
      [`storage:image/png:${sha256}`, storageUrlOf(png)]
    ]);
  });

  it("hits the cache for the same bytes at another path, and misses for another MIME type", async () => {
    const ctx = createTestCtx();
    stubStorageFetch();
    await uploadInputs(ctx, png, NO_REFS, OPTIONS);

    const copy = temp.file("copy.png", PNG, "image/png", "d".repeat(64));
    const asWebp = temp.file("same.webp", PNG, "image/webp", "e".repeat(64));
    const fetchMock = stubStorageFetch();
    const urls = await uploadInputs(ctx, copy, { ...NO_REFS, images: [asWebp] }, OPTIONS);

    expect(urls.image).toBe(storageUrlOf(png));
    expect(urls.refs).toEqual([storageUrlOf(asWebp)]);
    expect(initiatedNames(fetchMock)).toEqual([fileNameOf(asWebp)]);
  });

  it("never caches a data-URI fallback", async () => {
    const ctx = createTestCtx();
    stubFetch(jsonResponse(500, { detail: "down" }));
    const first = await uploadInputs(ctx, png, NO_REFS, OPTIONS);
    expect(first.image).toBe(toDataUri(PNG, "image/png"));
    expect(ctx.state.uploads.size).toBe(0);

    const fetchMock = stubStorageFetch();
    const second = await uploadInputs(ctx, png, NO_REFS, OPTIONS);

    expect(second.image).toBe(storageUrlOf(png));
    expect(initiateCount(fetchMock)).toBe(1);
  });

  it("caches nothing in data-uri mode", async () => {
    const ctx = createTestCtx({ config: { upload: "data-uri" } });
    stubFetch();

    await uploadInputs(ctx, png, { ...NO_REFS, videos: [mp4] }, OPTIONS);

    expect(ctx.state.uploads.size).toBe(0);
  });
});
