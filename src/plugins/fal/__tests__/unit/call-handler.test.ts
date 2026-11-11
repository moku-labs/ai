import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCallHandler } from "../../call/handler";
import { encodeJobId } from "../../client/queue";
import type { CallHandler, CallRequest, FalContext } from "../../types";
import type { TempFiles } from "./fixtures";
import {
  callsOf,
  createFakeEnv,
  createTempFiles,
  createTestCtx,
  DEFAULT_CONFIG,
  initiateCount,
  jsonBodyOf,
  jsonResponse,
  pngHeader,
  storageUrlOf,
  stubFetch,
  stubStorageFetch,
  submitResponse
} from "./fixtures";

const SAM_IMAGE = "fal-ai/sam-3/image";
const SAM_VIDEO = "fal-ai/sam-3/video-rle";
const SAM_BODY = "fal-ai/sam-3/3d-body";
const MOGE = "microsoft/moge-2";

/** A poll-only job id: the status and result URLs are the ones the stubs answer. */
function jobIdOf(endpoint: string): string {
  return encodeJobId({
    endpoint,
    requestId: "req-1",
    statusUrl: "https://queue.fal.run/custom/requests/req-1/status",
    responseUrl: "https://queue.fal.run/custom/requests/req-1"
  });
}

/** Stubs fetch for one poll: the status says COMPLETED, the result is `answer`. */
function stubCompletedJob(answer: unknown): ReturnType<typeof vi.fn> {
  return stubFetch(jsonResponse(200, { status: "COMPLETED" }), jsonResponse(200, answer));
}

/**
 * Makes every storage initiate of the stubbed global fetch take a few ms, so the parallel uploads of
 * one call overlap and only the handler (not the upload cache) can keep a repeated file to one upload.
 */
function slowDownUploads(): void {
  const stubbed = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === DEFAULT_CONFIG.uploadUrl) await new Promise(resolve => setTimeout(resolve, 10));
    return stubbed(url, init);
  });
}

/** The warnings of one event name, as `[event, fields]` pairs. */
function warningsOf(ctx: FalContext, event: string): unknown[][] {
  return vi.mocked(ctx.log.warn).mock.calls.filter(([name]) => name === event);
}

describe("call handler", () => {
  let files: TempFiles;
  let handler: CallHandler;
  let ctx: FalContext;

  /** Builds the handler under test on a fresh context. */
  function open(overrides: Parameters<typeof createTestCtx>[0] = {}): void {
    ctx = createTestCtx(overrides);
    handler = createCallHandler(ctx);
  }

  beforeEach(() => {
    files = createTempFiles();
    open();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    files.cleanup();
  });

  describe("check", () => {
    const INVALID =
      '[ai] Invalid fal call request.\n  Pass "endpoint" (a fal endpoint id, for example "fal-ai/sam-3/image") and "input" (a JSON object).';

    it.each([
      ["an empty endpoint", { endpoint: "", input: {} }],
      ["a missing endpoint", { input: {} }],
      ["a numeric endpoint", { endpoint: 7, input: {} }],
      ["an array input", { endpoint: SAM_IMAGE, input: [] }],
      // eslint-disable-next-line unicorn/no-null -- a JSON null input must be refused like any non-object
      ["a null input", { endpoint: SAM_IMAGE, input: null }],
      ["a string input", { endpoint: SAM_IMAGE, input: "x" }]
    ])("refuses %s as a terminal 400 from estimate and submit, with no network", async (_, bad) => {
      // Bug: a malformed build item posts garbage to fal and is billed.
      const fetchMock = stubFetch();
      const request = bad as unknown as CallRequest;

      expect(() => handler.estimate(request)).toThrow(INVALID);
      await expect(handler.submit(request, {})).rejects.toThrow(INVALID);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("estimate", () => {
    it("throws the no-price message for an endpoint with no row, and returns the override when set", () => {
      // Bug: an unpriced endpoint runs at cost 0.
      expect(() => handler.estimate({ endpoint: "x/y", input: {} })).toThrow(
        '[ai] No price for fal endpoint "x/y".\n  Add "call:x/y" to fal.priceOverrides (USD per request).'
      );

      open({ config: { priceOverrides: { "call:x/y": 0.01 } } });
      expect(handler.estimate({ endpoint: "x/y", input: {} })).toEqual({ usd: 0.01 });
    });

    it("is one unit of the rate: no network, no key, no file read", () => {
      // Bug: estimate reads the unresolved $file marker or the key, which it does not have.
      open({ env: createFakeEnv({}) });
      const fetchMock = stubFetch();

      expect(
        handler.estimate({ endpoint: SAM_BODY, input: { image_url: { $file: "x.png" } } })
      ).toEqual({
        usd: 0.02
      });
      expect(
        handler.estimate({ endpoint: MOGE, input: { image_url: { $file: "x.png" } } })
      ).toEqual({
        usd: 0.01
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("submit", () => {
    it("refuses an unpriced endpoint before the key, any upload or the POST", async () => {
      // Bug: money spent before the refusal (a file uploaded, or the job queued and billed).
      open({ env: createFakeEnv({}) });
      const fetchMock = stubStorageFetch();
      const plate = files.file("plate.png", pngHeader(10, 10), "image/png", "h-plate");

      await expect(
        handler.submit({ endpoint: "x/y", input: { image_url: plate } }, {})
      ).rejects.toThrow('No price for fal endpoint "x/y"');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("uploads each resolved file once and posts the URLs where the files were, nested and in arrays", async () => {
      // Bug: fal gets { path, mimeType, hash } and answers 422, or a local path leaks.
      // Different bytes: the upload cache is by content, so equal bytes would share one URL.
      const plate = files.file("a.png", pngHeader(10, 10), "image/png", "h-a");
      const mask = files.file("b.png", pngHeader(11, 11), "image/png", "h-b");
      const fetchMock = stubStorageFetch(submitResponse());
      slowDownUploads();
      // Objects that only look like a resolved file stay data: two fields short, or one field over.
      const lookalike = {
        partial: { path: "/not/a/file", label: "x" },
        extra: { path: "/p", mimeType: "image/png", hash: "h", note: "n" }
      };

      const { jobId } = await handler.submit(
        {
          endpoint: SAM_IMAGE,
          input: {
            image_url: plate,
            nested: {
              masks: [mask, "https://cdn.example.test/ref.png", 7, plate],
              keep: lookalike
            },
            prompt: "wall",
            apply_mask: false,
            count: 3
          },
          params: { ignored: true }
        },
        {}
      );

      const post = callsOf(fetchMock).find(call => call.url.startsWith("https://queue.fal.run/"));
      expect(post?.url).toBe(`https://queue.fal.run/${SAM_IMAGE}`);
      expect(post?.method).toBe("POST");
      expect(jsonBodyOf(post)).toEqual({
        image_url: storageUrlOf(plate),
        nested: {
          masks: [storageUrlOf(mask), "https://cdn.example.test/ref.png", 7, storageUrlOf(plate)],
          keep: lookalike
        },
        prompt: "wall",
        apply_mask: false,
        count: 3
      });
      expect(String(post?.body)).not.toContain(files.dir);
      expect(initiateCount(fetchMock)).toBe(2);
      expect(JSON.parse(jobId)).toMatchObject({ endpoint: SAM_IMAGE, requestId: "req-1" });
      expect(ctx.log.info).toHaveBeenCalledWith("fal:call:submitted", {
        endpoint: SAM_IMAGE,
        requestId: "req-1"
      });
    });

    it("posts an input without files as it is, with no upload", async () => {
      const fetchMock = stubFetch(submitResponse());

      await handler.submit({ endpoint: SAM_IMAGE, input: { prompt: "wall", seed: 1 } }, {});

      expect(callsOf(fetchMock)).toHaveLength(1);
      expect(jsonBodyOf(callsOf(fetchMock)[0])).toEqual({ prompt: "wall", seed: 1 });
    });

    it("refuses a megapixel endpoint whose image_url is a string, before the POST", async () => {
      // Bug: a paid call the package cannot price.
      const fetchMock = stubStorageFetch();
      const cannot = `[ai] Cannot price fal endpoint "${MOGE}".\n  It is billed per megapixel of input.image_url: pass that image as a local PNG, JPEG or WebP file.`;

      await expect(
        handler.submit(
          { endpoint: MOGE, input: { image_url: "https://cdn.example.test/x.png" } },
          {}
        )
      ).rejects.toThrow(cannot);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a megapixel endpoint whose image_url file has no readable size or is gone", async () => {
      const fetchMock = stubStorageFetch();
      const notAnImage = files.file("x.png", new Uint8Array([1, 2, 3, 4]), "image/png", "h-x");
      const gone = { path: path.join(files.dir, "gone.png"), mimeType: "image/png", hash: "h-g" };

      for (const image of [notAnImage, gone]) {
        await expect(
          handler.submit({ endpoint: MOGE, input: { image_url: image } }, {})
        ).rejects.toThrow("Cannot price fal endpoint");
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("poll", () => {
    it("returns fal's result body as JSON text with mime application/json and the rate of one request", async () => {
      // Bug: the store, and so the cache, holds something else than fal's answer.
      const answer = { meshes: [{ url: "https://v3.fal.media/files/m.glb" }], keypoints: [1, 2.5] };
      stubCompletedJob(answer);

      const poll = await handler.poll(jobIdOf(SAM_BODY), { endpoint: SAM_BODY, input: {} }, {});

      expect(poll).toEqual({
        state: "done",
        text: JSON.stringify(answer),
        mimeType: "application/json",
        costUsd: 0.02,
        meta: { endpoint: SAM_BODY, requestId: "req-1", unit: "request", units: 1 }
      });
      expect(ctx.log.info).toHaveBeenCalledWith("fal:call:done", { requestId: "req-1", units: 1 });
    });

    it("prices an override of a request endpoint", async () => {
      open({ config: { priceOverrides: { "call:x/y": 0.04 } } });
      stubCompletedJob({ ok: true });

      const poll = await handler.poll(jobIdOf("x/y"), { endpoint: "x/y", input: {} }, {});

      expect(poll).toMatchObject({ state: "done", costUsd: 0.04 });
    });

    it("costs 0.03 for moge-2 with a 1080x1920 PNG", async () => {
      // Bug: every megapixel call counted as one unit.
      const plate = files.file("plate.png", pngHeader(1080, 1920), "image/png", "h-plate");
      stubCompletedJob({ point_cloud: { url: "https://v3.fal.media/files/p.ply" } });

      const poll = await handler.poll(
        jobIdOf(MOGE),
        { endpoint: MOGE, input: { image_url: plate } },
        {}
      );

      expect(poll).toMatchObject({
        state: "done",
        costUsd: 0.03,
        meta: { unit: "megapixel", units: 3 }
      });
      expect(warningsOf(ctx, "fal:call:units-unknown")).toHaveLength(0);
    });

    it("bills one unit and warns once when moge-2's image is gone at poll time, and still answers", async () => {
      // Bug: a paid answer lost because a later process cannot read the image.
      const plate = files.file("plate.png", pngHeader(1080, 1920), "image/png", "h-plate");
      rmSync(plate.path);
      stubCompletedJob({ point_cloud: { url: "https://v3.fal.media/files/p.ply" } });

      const poll = await handler.poll(
        jobIdOf(MOGE),
        { endpoint: MOGE, input: { image_url: plate } },
        {}
      );

      expect(poll).toMatchObject({ state: "done", costUsd: 0.01, meta: { units: 1 } });
      expect(warningsOf(ctx, "fal:call:units-unknown")).toEqual([
        ["fal:call:units-unknown", { endpoint: MOGE, requestId: "req-1" }]
      ]);
    });

    it("bills video-rle one block per started 16 frames: 49 rle entries cost 0.02", async () => {
      // Bug: a long shot billed as one block.
      stubCompletedJob({ rle: Array.from({ length: 49 }, (_, frame) => `frame-${frame}`) });

      const poll = await handler.poll(jobIdOf(SAM_VIDEO), { endpoint: SAM_VIDEO, input: {} }, {});

      expect(poll).toMatchObject({
        state: "done",
        costUsd: 0.02,
        meta: { unit: "16-frames", units: 4 }
      });
      expect(warningsOf(ctx, "fal:call:units-unknown")).toHaveLength(0);
    });

    it("bills video-rle one block and warns once when the answer has no rle array", async () => {
      // Bug: a paid answer lost over a price detail.
      stubCompletedJob({ video: { url: "https://v3.fal.media/files/v.mp4" } });

      const poll = await handler.poll(jobIdOf(SAM_VIDEO), { endpoint: SAM_VIDEO, input: {} }, {});

      expect(poll).toMatchObject({ state: "done", costUsd: 0.005, meta: { units: 1 } });
      expect(warningsOf(ctx, "fal:call:units-unknown")).toEqual([
        ["fal:call:units-unknown", { endpoint: SAM_VIDEO, requestId: "req-1" }]
      ]);
    });

    it("reports fal's own failure as failed under the call event", async () => {
      // Bug: a failed call logs under another task's event, or throws instead of failing the item.
      stubFetch(
        jsonResponse(200, {
          status: "COMPLETED",
          error: "bad mask",
          error_type: "validation_error"
        })
      );

      const poll = await handler.poll(jobIdOf(SAM_IMAGE), { endpoint: SAM_IMAGE, input: {} }, {});

      expect(poll).toMatchObject({ state: "failed" });
      expect(warningsOf(ctx, "fal:call:failed")).toHaveLength(1);
    });
  });

  describe("request log", () => {
    it("writes one line with task call, the endpoint and the file names", async () => {
      // Bug: these calls are missing from the studio's .studio/log/fal.jsonl.
      const logPath = path.join(files.dir, "log", "fal.jsonl");
      open({ config: { requestLog: logPath } });
      const first = files.file("plate-a.png", pngHeader(10, 10), "image/png", "h-a");
      const second = files.file("plate-b.png", pngHeader(11, 11), "image/png", "h-b");
      stubStorageFetch(submitResponse());

      await handler.submit(
        { endpoint: SAM_IMAGE, input: { image_urls: [first, second], prompt: "wall" } },
        {}
      );

      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
        task: "call",
        model: SAM_IMAGE,
        endpoint: SAM_IMAGE,
        requestId: "req-1",
        prompt: "wall",
        body: { image_urls: ["plate-a.png", "plate-b.png"] }
      });
    });

    it("logs an empty prompt when the input has no string prompt", async () => {
      const logPath = path.join(files.dir, "fal.jsonl");
      open({ config: { requestLog: logPath } });
      stubFetch(submitResponse());

      await handler.submit({ endpoint: SAM_IMAGE, input: { prompt: 5 } }, {});

      const [line] = readFileSync(logPath, "utf8").trim().split("\n");
      expect(JSON.parse(line ?? "{}")).toMatchObject({ prompt: "" });
    });
  });
});
