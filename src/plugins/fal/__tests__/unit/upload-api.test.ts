import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createFalApi } from "../../api";
import { createUploadSession, toDataUri, uploadOne } from "../../client/upload";
import { RetryableProviderError, TerminalProviderError } from "../../errors";
import type { LocalFile, UploadMode } from "../../types";
import type { TempFiles } from "./fixtures";
import {
  callsOf,
  createFakeEnv,
  createTempFiles,
  createTestCtx,
  DEFAULT_CONFIG,
  initiateResponse,
  jsonBodyOf,
  jsonResponse,
  okResponse,
  stubFetch,
  TEST_KEY
} from "./fixtures";

const BYTES = new Uint8Array([1, 1]);
const HASH = "9dcf97a184f32623d11a73124ceb99a5709b083721e878a16d78f596718ba7b2";
const FILE_URL = "https://cdn.fal.test/file/1";
const OPTIONS = { apiKey: TEST_KEY };
const MODES: UploadMode[] = ["storage", "data-uri"];

let temp: TempFiles;
let local: LocalFile;
let file: Pick<LocalFile, "path" | "mimeType">;

beforeAll(() => {
  temp = createTempFiles();
  local = temp.file("portrait.png", BYTES, "image/png", "a".repeat(64));
  file = { path: local.path, mimeType: local.mimeType };
});

afterAll(() => {
  temp.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createFalApi().upload()", () => {
  it.each(MODES)("returns the public file URL in %s mode after initiate and PUT", async upload => {
    const fetchMock = stubFetch(initiateResponse(1), okResponse());
    const ctx = createTestCtx({ config: { upload } });
    const api = createFalApi(ctx);

    expectTypeOf(api.upload).toEqualTypeOf<
      (
        file: { path: string; mimeType: string },
        opts?: { signal?: AbortSignal }
      ) => Promise<{ url: string }>
    >();
    await expect(api.upload(file)).resolves.toEqual({ url: FILE_URL });

    const calls = callsOf(fetchMock);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(DEFAULT_CONFIG.uploadUrl);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.Authorization).toBe(`Key ${TEST_KEY}`);
    expect(jsonBodyOf(calls[0])).toEqual({
      file_name: `${HASH.slice(0, 16)}.png`,
      content_type: "image/png"
    });
    expect(calls[1]?.url).toBe("https://upload.fal.test/put/1");
    expect(calls[1]?.method).toBe("PUT");
    expect(calls[1]?.headers["content-type"]).toBe("image/png");
    expect(calls[1]?.headers.Authorization).toBeUndefined();
    expect(calls[1]?.body).toEqual(BYTES);
    expect([...ctx.state.uploads.entries()]).toEqual([[`storage:image/png:${HASH}`, FILE_URL]]);
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it("reads the configured key at call time", async () => {
    const values = { MY_FAL: "first-key" };
    const api = createFalApi(
      createTestCtx({ config: { apiKeyEnv: "MY_FAL" }, env: createFakeEnv(values) })
    );
    values.MY_FAL = "second-key";
    const fetchMock = stubFetch(initiateResponse(1), okResponse());

    await expect(api.upload(file)).resolves.toEqual({ url: FILE_URL });

    expect(callsOf(fetchMock)[0]?.headers.Authorization).toBe("Key second-key");
  });

  it("throws the existing missing-key error before any fetch", async () => {
    const fetchMock = stubFetch();
    const api = createFalApi(createTestCtx({ env: createFakeEnv({}) }));

    await expect(api.upload(file)).rejects.toThrow(
      "[ai] FAL_KEY is not set.\n  Export it, or set fal.apiKeyEnv to the variable that holds your key."
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws the existing unreadable-file error before any fetch", async () => {
    const fetchMock = stubFetch();
    const missing = { path: `${temp.dir}/missing.png`, mimeType: "image/png" };

    await expect(createFalApi(createTestCtx()).upload(missing)).rejects.toThrow(
      `[ai] Cannot read fal input file "${missing.path}".\n  Check that the $ref or $file it came from still exists.`
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(MODES)("throws the provider error on failed initiate in %s mode", async upload => {
    const fetchMock = stubFetch(jsonResponse(503, {}));
    const ctx = createTestCtx({ config: { upload } });
    const pending = createFalApi(ctx).upload(file);

    await expect(pending).rejects.toBeInstanceOf(RetryableProviderError);
    await expect(pending).rejects.toMatchObject({
      status: 503,
      message: "[ai] fal returned HTTP 503."
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ctx.state.uploads.size).toBe(0);
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it.each(MODES)("throws the provider error on failed PUT in %s mode", async upload => {
    const fetchMock = stubFetch(initiateResponse(1), jsonResponse(403, {}));
    const ctx = createTestCtx({ config: { upload } });
    const pending = createFalApi(ctx).upload(file);

    await expect(pending).rejects.toBeInstanceOf(TerminalProviderError);
    await expect(pending).rejects.toMatchObject({
      status: 403,
      message: "[ai] fal rejected the request (HTTP 403)."
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ctx.state.uploads.size).toBe(0);
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it("uploads to storage after an earlier session fell back to a data URI", async () => {
    const ctx = createTestCtx();
    const session = createUploadSession(ctx);
    stubFetch(jsonResponse(500, {}));
    await expect(uploadOne(ctx, session, local, OPTIONS)).resolves.toBe(
      toDataUri(BYTES, "image/png")
    );
    expect(session.mode).toBe("data-uri");
    const fetchMock = stubFetch(initiateResponse(1), okResponse());

    await expect(createFalApi(ctx).upload(file)).resolves.toEqual({ url: FILE_URL });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
    expect([...ctx.state.uploads.values()]).toEqual([FILE_URL]);
  });

  it("throws on failure after an earlier session fell back to a data URI", async () => {
    const ctx = createTestCtx();
    stubFetch(jsonResponse(500, {}));
    await uploadOne(ctx, createUploadSession(ctx), local, OPTIONS);
    const fetchMock = stubFetch(initiateResponse(1), jsonResponse(503, {}));

    await expect(createFalApi(ctx).upload(file)).rejects.toBeInstanceOf(RetryableProviderError);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
    expect(ctx.state.uploads.size).toBe(0);
  });

  it.each(MODES)("returns an existing task's cached storage URL in %s mode", async upload => {
    const ctx = createTestCtx();
    stubFetch(initiateResponse(1), okResponse());
    await uploadOne(ctx, createUploadSession(ctx), local, OPTIONS);
    const publicCtx = createTestCtx({ config: { upload }, state: ctx.state });
    const fetchMock = stubFetch();

    await expect(createFalApi(publicCtx).upload(file)).resolves.toEqual({ url: FILE_URL });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reuses uploaded bytes at another path, separating MIME types", async () => {
    const ctx = createTestCtx();
    const api = createFalApi(ctx);
    const copy = temp.file("copy.png", BYTES, "image/png", "b".repeat(64));
    stubFetch(initiateResponse(1), okResponse());
    await api.upload(file);
    const fetchMock = stubFetch(initiateResponse(2), okResponse());

    await expect(api.upload({ path: copy.path, mimeType: copy.mimeType })).resolves.toEqual({
      url: FILE_URL
    });
    await expect(api.upload({ path: copy.path, mimeType: "image/webp" })).resolves.toEqual({
      url: "https://cdn.fal.test/file/2"
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(jsonBodyOf(callsOf(fetchMock)[0]).file_name).toBe(`${HASH.slice(0, 16)}.webp`);
    expect(ctx.state.uploads.size).toBe(2);
  });

  it.each([
    "http://cdn.fal.test/file/1",
    "data:image/png;base64,AQE=",
    "relative.png"
  ])("rejects a non-https file URL (%s) without caching it", async url => {
    stubFetch(
      jsonResponse(200, { upload_url: "https://upload.fal.test/put/1", file_url: url }),
      okResponse()
    );
    const ctx = createTestCtx();

    await expect(createFalApi(ctx).upload(file)).rejects.toThrow(
      "[ai] fal returned an unreadable upload target.\n  Expected an https file URL."
    );

    expect(ctx.state.uploads.size).toBe(0);
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT"])("rethrows a caller abort during %s unchanged", async method => {
    const controller = new AbortController();
    const abortError = new DOMException("paused", "AbortError");
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        if (init.method !== method) return Promise.resolve(initiateResponse(1));
        seen = init.signal ?? undefined;
        controller.abort();
        return Promise.reject(abortError);
      })
    );
    const ctx = createTestCtx();

    await expect(createFalApi(ctx).upload(file, { signal: controller.signal })).rejects.toBe(
      abortError
    );

    expect(seen?.aborted).toBe(true);
    expect(ctx.state.uploads.size).toBe(0);
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });
});
