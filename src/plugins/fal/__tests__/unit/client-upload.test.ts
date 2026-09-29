import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createUploadSession,
  toDataUri,
  UPLOAD_SLOTS,
  uploadFiles,
  uploadOne
} from "../../client/upload";
import type { LocalFile } from "../../types";
import type { TempFiles } from "./fixtures";
import {
  callsOf,
  createLocalFile,
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

// ─────────────────────────────────────────────────────────────────────────────
// Generic upload over LocalFile: order, slots, sha256 cache, fallback.
// ─────────────────────────────────────────────────────────────────────────────

const OPTIONS = { apiKey: TEST_KEY };

let temp: TempFiles;
let files: LocalFile[];

beforeAll(() => {
  temp = createTempFiles();
  files = [1, 2, 3, 4, 5, 6].map(n =>
    temp.file(`still${n}.png`, new Uint8Array([n, n]), "image/png", String(n).repeat(64))
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

describe("uploadFiles", () => {
  it("returns one storage URL per file, in file order", async () => {
    stubStorageFetch();
    const urls = await uploadFiles(createTestCtx(), files, OPTIONS);
    expect(urls).toEqual(files.map(file => storageUrlOf(file)));
  });

  it(`runs at most ${UPLOAD_SLOTS} uploads at once`, async () => {
    let active = 0;
    let peak = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== DEFAULT_CONFIG.uploadUrl) {
        active -= 1;
        return okResponse();
      }
      active += 1;
      peak = Math.max(peak, active);
      await sleep(5);
      const { file_name: fileName } = JSON.parse(String(init?.body)) as { file_name: string };
      return jsonResponse(200, {
        upload_url: `https://upload.fal.test/put/${fileName}`,
        file_url: `https://cdn.fal.test/file/${fileName}`
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await uploadFiles(createTestCtx(), files, OPTIONS);

    expect(peak).toBe(UPLOAD_SLOTS);
    expect(initiateCount(fetchMock)).toBe(6);
  });

  it("uploads the same bytes once per process, whichever task asks", async () => {
    const fetchMock = stubStorageFetch();
    const ctx = createTestCtx();
    const [first] = files;
    if (first === undefined) throw new Error("fixture missing");
    const copy = createLocalFile("copy.png", new Uint8Array([1, 1]), "image/png", "f".repeat(64));

    const imageUrls = await uploadFiles(ctx, [first], OPTIONS);
    const llmUrls = await uploadFiles(ctx, [copy.file], OPTIONS);
    copy.cleanup();

    expect(llmUrls).toEqual(imageUrls);
    expect(initiateCount(fetchMock)).toBe(1);
    expect([...ctx.state.uploads.keys()]).toEqual([
      "storage:image/png:9dcf97a184f32623d11a73124ceb99a5709b083721e878a16d78f596718ba7b2"
    ]);
  });

  it("falls back to data URIs after a failed upload and logs it once", async () => {
    const fetchMock = stubFetch(jsonResponse(500, {}), jsonResponse(500, {}));
    const ctx = createTestCtx();
    const [one, two] = files;
    if (one === undefined || two === undefined) throw new Error("fixture missing");

    const urls = await uploadFiles(ctx, [one, two], OPTIONS);

    expect(urls).toEqual([
      toDataUri(new Uint8Array([1, 1]), "image/png"),
      toDataUri(new Uint8Array([2, 2]), "image/png")
    ]);
    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
    expect(ctx.log.warn).toHaveBeenCalledWith("fal:upload:fallback", { status: 500 });
    expect(initiateCount(fetchMock)).toBeGreaterThanOrEqual(1);
    expect(ctx.state.uploads.size).toBe(0);
  });

  it("makes no call for an empty list", async () => {
    const fetchMock = stubFetch();
    expect(await uploadFiles(createTestCtx(), [], OPTIONS)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("inlines every file in data-uri mode, without a call", async () => {
    const fetchMock = stubFetch();
    const [one] = files;
    if (one === undefined) throw new Error("fixture missing");
    const urls = await uploadFiles(
      createTestCtx({ config: { upload: "data-uri" } }),
      [one],
      OPTIONS
    );
    expect(urls).toEqual([toDataUri(new Uint8Array([1, 1]), "image/png")]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("continues a given session: a session already on data-uri makes no call", async () => {
    const fetchMock = stubFetch();
    const [one] = files;
    if (one === undefined) throw new Error("fixture missing");
    const urls = await uploadFiles(createTestCtx(), [one], OPTIONS, { mode: "data-uri" });
    expect(urls[0]?.startsWith("data:image/png;base64,")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names the storage file after the hash and the MIME type", async () => {
    const fetchMock = stubStorageFetch();
    const [one] = files;
    if (one === undefined) throw new Error("fixture missing");
    await uploadFiles(createTestCtx(), [one], OPTIONS);
    const initiate = callsOf(fetchMock).find(call => call.url === DEFAULT_CONFIG.uploadUrl);
    expect(jsonBodyOf(initiate)).toEqual({
      file_name: "1111111111111111.png",
      content_type: "image/png"
    });
  });
});

describe("createUploadSession and uploadOne", () => {
  it("starts a session at config.upload", () => {
    expect(createUploadSession(createTestCtx())).toEqual({ mode: "storage" });
    expect(createUploadSession(createTestCtx({ config: { upload: "data-uri" } }))).toEqual({
      mode: "data-uri"
    });
  });

  it("rejects an unreadable file with a plain two-line error", async () => {
    stubFetch();
    const missing: LocalFile = { path: "/nope/x.png", mimeType: "image/png", hash: "h" };
    await expect(
      uploadOne(createTestCtx(), createUploadSession(createTestCtx()), missing, OPTIONS)
    ).rejects.toThrow(
      '[ai] Cannot read fal input file "/nope/x.png".\n  Check that the $ref or $file it came from still exists.'
    );
  });
});
