import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { SpriteFile, SpriteHandler, SpriteRequest } from "../../../sprite/contract";
import { TerminalProviderError } from "../../errors";
import { createSpriteHandler } from "../../sprite/handler";
import type { LocalFile } from "../../types";
import {
  bytesResponse,
  callsOf,
  createFakeEnv,
  createLocalFile,
  createTestCtx,
  DEFAULT_CONFIG,
  jsonBodyOf,
  jsonResponse,
  storageUrlOf,
  stubFetch,
  stubStorageFetch,
  submitResponse
} from "./fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// ("sprite", "fal"): the BiRefNet matte on fal, or none, then the real pixel
// step (sharp) on a PNG generated here.
// ─────────────────────────────────────────────────────────────────────────────

const ENDPOINT = "fal-ai/birefnet/v2";
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

/** A 32x32 transparent PNG with an opaque 10x6 block at (5,7). */
async function blockPng(): Promise<Uint8Array> {
  const block = await sharp({
    create: { width: 10, height: 6, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 1 } }
  })
    .png()
    .toBuffer();
  const png = await sharp({
    create: { width: 32, height: 32, channels: 4, background: TRANSPARENT }
  })
    .composite([{ input: block, left: 5, top: 7 }])
    .png()
    .toBuffer();
  return new Uint8Array(png);
}

/** Width, height and channel count of a PNG. */
async function geometryOf(png: Uint8Array): Promise<{
  width: number | undefined;
  height: number | undefined;
  channels: number | undefined;
  format: string | undefined;
}> {
  const { width, height, channels, format } = await sharp(png).metadata();
  return { width, height, channels, format };
}

/** The error `promise` rejects with. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

let matte: Uint8Array;
let source: LocalFile;
let cleanup: () => void;

beforeAll(async () => {
  matte = await blockPng();
  ({ file: source, cleanup } = createLocalFile(
    "raw.png",
    matte,
    "image/png",
    "abcd1234abcd1234ffff"
  ));
  return () => cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The queue responses of one finished BiRefNet job, after the upload. */
function finishedMatte(image: Record<string, unknown>, download: Response): Response[] {
  return [
    submitResponse("req-1"),
    jsonResponse(200, { status: "COMPLETED" }),
    jsonResponse(200, { image }),
    download
  ];
}

/** The non-upload calls of a storage-stubbed fetch, in order. */
function queueCalls(fetchMock: ReturnType<typeof vi.fn>): ReturnType<typeof callsOf> {
  return callsOf(fetchMock).filter(
    call =>
      call.url !== DEFAULT_CONFIG.uploadUrl && !call.url.startsWith("https://upload.fal.test/")
  );
}

describe("estimate", () => {
  it("reads the model only: birefnet is $0.002, none is 0, an unresolved source is fine", () => {
    const fetchMock = stubFetch();
    const handler = createSpriteHandler(createTestCtx({ env: createFakeEnv({}) }));
    // The runner estimates before it resolves the $ref: the shape the type refuses is the case under test.
    const unresolved: unknown = { $ref: "btn-raw" };
    const request = { source: unresolved as SpriteFile, model: "birefnet" };
    expect(handler.estimate(request)).toEqual({ usd: 0.002 });
    expect(handler.estimate({ ...request, model: "none" })).toEqual({ usd: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads sprite: overrides and refuses an unknown model as a terminal 400", () => {
    const ctx = createTestCtx({ config: { priceOverrides: { "sprite:birefnet": 0.004 } } });
    const handler = createSpriteHandler(ctx);
    expect(handler.estimate({ source, model: "birefnet" })).toEqual({ usd: 0.004 });
    expect(() => handler.estimate({ source, model: "rembg" })).toThrow(TerminalProviderError);
  });
});

describe("execute with none", () => {
  it("cuts the source itself: no key, no HTTP, cost 0", async () => {
    const fetchMock = stubFetch();
    const handler = createSpriteHandler(createTestCtx({ env: createFakeEnv({}) }));

    const result = await handler.execute({ source, model: "none", padding: 1 }, {});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.mimeType).toBe("image/png");
    expect(result.costUsd).toBe(0);
    expect(result.meta).toEqual({
      model: "none",
      width: 12,
      height: 8,
      trimBox: { left: 5, top: 7, width: 10, height: 6 }
    });
    expect(await geometryOf(result.image)).toEqual({
      width: 12,
      height: 8,
      channels: 4,
      format: "png"
    });
  });

  it("says which source it cannot read", async () => {
    const missing = { path: "/nowhere/raw.png", mimeType: "image/png", hash: "h" };
    await expect(
      createSpriteHandler(createTestCtx()).execute({ source: missing, model: "none" }, {})
    ).rejects.toThrow(
      '[ai] Cannot read sprite source "/nowhere/raw.png".\n  Check that the $ref or $file it came from still exists.'
    );
  });

  it("stops before any work when the caller already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("paused"));
    await expect(
      createSpriteHandler(createTestCtx()).execute(
        { source, model: "none" },
        { signal: controller.signal }
      )
    ).rejects.toThrow("paused");
  });
});

describe("execute with birefnet", () => {
  it("uploads the source, runs the matte job, downloads it and passes the processSprite output through", async () => {
    const fetchMock = stubStorageFetch(
      ...finishedMatte(
        { url: "https://v3.fal.media/files/matte.png", content_type: "image/png" },
        bytesResponse(matte, "image/png")
      )
    );
    const ctx = createTestCtx();

    const result = await createSpriteHandler(ctx).execute(
      { source, model: "birefnet", size: { width: 16, height: 16 }, pixelArt: true },
      {}
    );

    const [post] = queueCalls(fetchMock);
    expect(post?.url).toBe(`https://queue.fal.run/${ENDPOINT}`);
    expect(jsonBodyOf(post)).toEqual({
      image_url: storageUrlOf(source),
      model: "General Use (Light)",
      operating_resolution: "1024x1024",
      output_format: "png",
      refine_foreground: true
    });
    expect(result.costUsd).toBe(0.002);
    expect(result.mimeType).toBe("image/png");
    expect(result.meta).toEqual({
      model: "birefnet",
      endpoint: ENDPOINT,
      requestId: "req-1",
      width: 16,
      height: 16,
      trimBox: { left: 5, top: 7, width: 10, height: 6 }
    });
    expect(await geometryOf(result.image)).toMatchObject({ width: 16, height: 16, channels: 4 });
    expect(ctx.log.info).toHaveBeenCalledWith("fal:sprite:submitted", {
      model: "birefnet",
      endpoint: ENDPOINT,
      requestId: "req-1"
    });
    expect(ctx.log.info).toHaveBeenCalledWith("fal:sprite:done", {
      requestId: "req-1",
      bytes: matte.length
    });
  });

  it("passes params.model and params.operating_resolution to fal", async () => {
    const fetchMock = stubStorageFetch(
      ...finishedMatte(
        { url: "https://v3.fal.media/files/matte.png" },
        bytesResponse(matte, "image/png")
      )
    );
    await createSpriteHandler(createTestCtx()).execute(
      {
        source,
        model: "birefnet",
        params: { model: "Matting", operating_resolution: "2048x2048" }
      },
      {}
    );
    expect(jsonBodyOf(queueCalls(fetchMock)[0])).toMatchObject({
      model: "Matting",
      operating_resolution: "2048x2048"
    });
  });

  it.each([
    ["an unresolved source", { source: { $ref: "btn-raw" } }],
    ["a bad padding", { padding: -2 }],
    ["an undocumented BiRefNet variant", { params: { model: "General Use (Huge)" } }]
  ])("refuses %s before it reads the key, uploads or calls fal", async (_label, extra) => {
    const fetchMock = stubFetch();
    const handler = createSpriteHandler(createTestCtx({ env: createFakeEnv({}) }));
    // A runtime shape the type system would refuse: the zod schema is the guard under test.
    const request: unknown = { source, model: "birefnet", ...extra };
    const error = await rejectionOf(handler.execute(request as SpriteRequest, {}));
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("needs the key", async () => {
    const fetchMock = stubFetch();
    const handler = createSpriteHandler(createTestCtx({ env: createFakeEnv({}) }));
    await expect(handler.execute({ source, model: "birefnet" }, {})).rejects.toThrow(
      "[ai] FAL_KEY is not set."
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a plain error for a result without image.url", async () => {
    stubStorageFetch(
      submitResponse("req-1"),
      jsonResponse(200, { status: "COMPLETED" }),
      jsonResponse(200, { image: {} })
    );
    await expect(
      createSpriteHandler(createTestCtx()).execute({ source, model: "birefnet" }, {})
    ).rejects.toThrow(
      "[ai] fal returned an incomplete sprite result.\n  Expected image.url in the response."
    );
  });

  it("does not submit when the caller aborted during the upload", async () => {
    const controller = new AbortController();
    const fetchMock = stubStorageFetch();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort(new Error("paused"));
      return jsonResponse(200, {
        upload_url: "https://upload.fal.test/put/raw",
        file_url: "https://cdn.fal.test/file/raw"
      });
    });
    await expect(
      createSpriteHandler(createTestCtx()).execute(
        { source, model: "birefnet" },
        { signal: controller.signal }
      )
    ).rejects.toThrow("paused");
    expect(queueCalls(fetchMock)).toHaveLength(0);
  });

  it("writes the request log line with the source named, no prompt", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "moku-fal-sprite-"));
    const requestLog = path.join(dir, "fal.jsonl");
    try {
      stubStorageFetch(
        ...finishedMatte(
          { url: "https://v3.fal.media/files/matte.png" },
          bytesResponse(matte, "image/png")
        )
      );
      await createSpriteHandler(createTestCtx({ config: { requestLog } })).execute(
        { source, model: "birefnet" },
        {}
      );
      const line = JSON.parse(readFileSync(requestLog, "utf8").trim()) as Record<string, unknown>;
      expect(line).toMatchObject({
        task: "sprite",
        model: "birefnet",
        endpoint: ENDPOINT,
        requestId: "req-1",
        prompt: "",
        body: { model: "General Use (Light)", output_format: "png", refine_foreground: true }
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("satisfies the sprite contract", () => {
    expectTypeOf(createSpriteHandler(createTestCtx())).toEqualTypeOf<SpriteHandler>();
  });
});
