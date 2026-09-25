import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fileNameOf, toDataUri, uploadInputs } from "../../upload";
import type { TempFiles } from "./fixtures";
import {
  callsOf,
  createTempFiles,
  createTestCtx,
  initiateResponse,
  jsonBodyOf,
  jsonResponse,
  okResponse,
  stubFetch,
  TEST_KEY
} from "./fixtures";

const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const JPG = new Uint8Array([255, 216, 255, 9]);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

let temp: TempFiles;

beforeAll(() => {
  temp = createTempFiles();
});

afterAll(() => {
  temp.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadInputs — storage mode", () => {
  it("initiates, PUTs the bytes, and returns the file URL for each file", async () => {
    const png = temp.file("a.png", PNG, "image/png", HASH_A);
    const jpg = temp.file("b.jpg", JPG, "image/jpeg", HASH_B);
    const fetchMock = stubFetch(
      initiateResponse(1),
      okResponse(),
      initiateResponse(2),
      okResponse()
    );

    const urls = await uploadInputs(
      createTestCtx(),
      png,
      { images: [jpg], audio: [], videos: [] },
      { apiKey: TEST_KEY }
    );

    expect(urls).toEqual({
      image: "https://cdn.fal.test/file/1",
      refs: ["https://cdn.fal.test/file/2"],
      audioRefs: [],
      videoRefs: []
    });
    const calls = callsOf(fetchMock);
    expect(calls).toHaveLength(4);
    expect(calls[0]?.url).toBe(
      "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3"
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.Authorization).toBe(`Key ${TEST_KEY}`);
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(jsonBodyOf(calls[0])).toEqual({
      file_name: `${"a".repeat(16)}.png`,
      content_type: "image/png"
    });
    expect(calls[1]?.url).toBe("https://upload.fal.test/put/1");
    expect(calls[1]?.method).toBe("PUT");
    expect(calls[1]?.headers["content-type"]).toBe("image/png");
    expect(new Uint8Array(calls[1]?.body as Uint8Array)).toEqual(PNG);
    expect(jsonBodyOf(calls[2])).toEqual({
      file_name: `${"b".repeat(16)}.jpg`,
      content_type: "image/jpeg"
    });
  });

  it("falls back to data URIs for this and later files when initiate fails", async () => {
    const png = temp.file("c.png", PNG, "image/png", HASH_A);
    const jpg = temp.file("d.jpg", JPG, "image/jpeg", HASH_B);
    const fetchMock = stubFetch(jsonResponse(500, { detail: "down" }));
    const ctx = createTestCtx();

    const urls = await uploadInputs(
      ctx,
      png,
      { images: [jpg], audio: [], videos: [] },
      { apiKey: TEST_KEY }
    );

    expect(urls).toEqual({
      image: toDataUri(PNG, "image/png"),
      refs: [toDataUri(JPG, "image/jpeg")],
      audioRefs: [],
      videoRefs: []
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
    expect(ctx.log.warn).toHaveBeenCalledWith("fal:upload:fallback", { status: 500 });
  });

  it("falls back when initiate fails at the network level", async () => {
    const png = temp.file("e.png", PNG, "image/png", HASH_A);
    stubFetch(new TypeError("fetch failed"));
    const ctx = createTestCtx();

    const urls = await uploadInputs(
      ctx,
      png,
      { images: [], audio: [], videos: [] },
      { apiKey: TEST_KEY }
    );

    expect(urls).toEqual({
      image: toDataUri(PNG, "image/png"),
      refs: [],
      audioRefs: [],
      videoRefs: []
    });
    expect(ctx.log.warn).toHaveBeenCalledWith("fal:upload:fallback", { status: undefined });
  });

  it("falls back when the initiate response lacks upload_url/file_url", async () => {
    const png = temp.file("f.png", PNG, "image/png", HASH_A);
    stubFetch(jsonResponse(200, { upload_url: "https://u" }));

    const urls = await uploadInputs(
      createTestCtx(),
      png,
      { images: [], audio: [], videos: [] },
      { apiKey: TEST_KEY }
    );

    expect(urls.image).toBe(toDataUri(PNG, "image/png"));
  });

  it("falls back to a data URI when the PUT fails", async () => {
    const png = temp.file("g.png", PNG, "image/png", HASH_A);
    stubFetch(initiateResponse(1), jsonResponse(503, {}));
    const ctx = createTestCtx();

    const urls = await uploadInputs(
      ctx,
      png,
      { images: [], audio: [], videos: [] },
      { apiKey: TEST_KEY }
    );

    expect(urls.image).toBe(toDataUri(PNG, "image/png"));
    expect(ctx.log.warn).toHaveBeenCalledWith("fal:upload:fallback", { status: 503 });
  });

  it("rethrows a caller abort during initiate instead of falling back", async () => {
    const png = temp.file("h.png", PNG, "image/png", HASH_A);
    const controller = new AbortController();
    const abortError = new DOMException("paused", "AbortError");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        controller.abort();
        return Promise.reject(abortError);
      })
    );
    const ctx = createTestCtx();

    await expect(
      uploadInputs(
        ctx,
        png,
        { images: [], audio: [], videos: [] },
        { apiKey: TEST_KEY, signal: controller.signal }
      )
    ).rejects.toBe(abortError);
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it("uploads only the image when there are no refs", async () => {
    const png = temp.file("j.png", PNG, "image/png", HASH_A);
    const fetchMock = stubFetch(initiateResponse(1), okResponse());
    const urls = await uploadInputs(
      createTestCtx(),
      png,
      { images: [], audio: [], videos: [] },
      { apiKey: TEST_KEY }
    );
    expect(urls).toEqual({
      image: "https://cdn.fal.test/file/1",
      refs: [],
      audioRefs: [],
      videoRefs: []
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("uploadInputs — data-uri mode", () => {
  it("inlines every file as a base64 data URI without any fetch", async () => {
    const png = temp.file("i.png", PNG, "image/png", HASH_A);
    const fetchMock = stubFetch();

    const urls = await uploadInputs(
      createTestCtx({ config: { upload: "data-uri" } }),
      png,
      { images: [], audio: [], videos: [] },
      {
        apiKey: TEST_KEY
      }
    );

    expect(urls.image).toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a readable [ai] error when the file cannot be read", async () => {
    const missing = { path: `${temp.dir}/missing.png`, mimeType: "image/png", hash: HASH_A };
    await expect(
      uploadInputs(
        createTestCtx({ config: { upload: "data-uri" } }),
        missing,
        { images: [], audio: [], videos: [] },
        {
          apiKey: TEST_KEY
        }
      )
    ).rejects.toThrow(/^\[ai\] Cannot read fal input file/);
  });
});

describe("fileNameOf", () => {
  it("uses the first 16 hash chars and an extension from the mime type", () => {
    expect(fileNameOf({ path: "/x/y", mimeType: "image/webp", hash: HASH_A })).toBe(
      `${"a".repeat(16)}.webp`
    );
    expect(fileNameOf({ path: "/x/y", mimeType: "video/mp4", hash: HASH_B })).toBe(
      `${"b".repeat(16)}.mp4`
    );
  });

  it("falls back to the path extension, then bin", () => {
    expect(fileNameOf({ path: "/x/pic.heic", mimeType: "image/heic", hash: HASH_A })).toBe(
      `${"a".repeat(16)}.heic`
    );
    expect(fileNameOf({ path: "/x/blob", mimeType: "application/x-thing", hash: HASH_A })).toBe(
      `${"a".repeat(16)}.bin`
    );
  });
});
