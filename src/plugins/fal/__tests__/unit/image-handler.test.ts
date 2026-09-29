import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { ImageFile, ImageHandler, ImageRequest } from "../../../image/contract";
import { encodeJobId } from "../../client/queue";
import { TerminalProviderError } from "../../errors";
import { createImageHandler } from "../../image/handler";
import type { TempFiles } from "./fixtures";
import {
  bytesResponse,
  callsOf,
  createFakeEnv,
  createTempFiles,
  createTestCtx,
  DEFAULT_CONFIG,
  jsonBodyOf,
  jsonResponse,
  okResponse,
  storageUrlOf,
  stubFetch,
  stubStorageFetch,
  submitResponse
} from "./fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// ("image", "fal"): estimate, submit/poll job form, execute.
// ─────────────────────────────────────────────────────────────────────────────

const JPEG = new Uint8Array([255, 216, 255, 1]);
const JOB_ID = encodeJobId({
  endpoint: "openai/gpt-image-2.5/sunburst/text-to-image",
  requestId: "req-1",
  statusUrl: "https://queue.fal.run/custom/requests/req-1/status-x",
  responseUrl: "https://queue.fal.run/custom/requests/req-1/result-x"
});

let temp: TempFiles;
let face: ImageFile;
let plate: ImageFile;

beforeAll(() => {
  temp = createTempFiles();
  face = temp.file("face.png", new Uint8Array([1, 2]), "image/png", "a".repeat(64));
  plate = temp.file("plate.jpg", new Uint8Array([3, 4]), "image/jpeg", "b".repeat(64));
});

afterAll(() => {
  temp.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The status + result + download responses of one finished image job. */
function finishedJob(image: Record<string, unknown>, download: Response): Response[] {
  return [
    jsonResponse(200, { status: "COMPLETED" }),
    jsonResponse(200, { images: [image] }),
    download
  ];
}

/** Captures what a promise rejects with. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("estimate", () => {
  it("prices the default model without I/O", () => {
    const fetchMock = stubFetch();
    const handler = createImageHandler(createTestCtx({ env: createFakeEnv({}) }));
    expect(handler.estimate({ prompt: "p" })).toEqual({ usd: 0.05 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prices nano-banana-pro by resolution", () => {
    const handler = createImageHandler(createTestCtx());
    expect(handler.estimate({ prompt: "p", model: "nano-banana-pro" })).toEqual({ usd: 0.15 });
    const at4k = { prompt: "p", model: "nano-banana-pro", params: { resolution: "4K" } };
    expect(handler.estimate(at4k)).toEqual({ usd: 0.3 });
  });

  it("counts refs that are still $ref objects, without reading them", () => {
    const handler = createImageHandler(createTestCtx());
    const unresolved = { $ref: "s01.face" } as unknown as ImageFile;
    const refs = Array.from({ length: 11 }, () => unresolved);
    expect(() => handler.estimate({ prompt: "p", model: "seedream-4.5-edit", refs })).toThrow(
      '[ai] fal image model "seedream-4.5-edit" takes at most 10 reference images, got 11.\n  Remove refs from input.refs, or use a model that takes more.'
    );
  });

  it("refuses a model without a price as terminal", () => {
    const handler = createImageHandler(createTestCtx({ state: { prices: {} } }));
    expect(() => handler.estimate({ prompt: "p" })).toThrow(
      '[ai] No price for fal image model "gpt-image-2.5".'
    );
  });
});

describe("submit", () => {
  it.each<[string, ImageRequest]>([
    ["an unknown model", { prompt: "p", model: "dall-e" }],
    [
      "too many refs",
      {
        prompt: "p",
        model: "seedream-4.5-edit",
        refs: Array.from({ length: 11 }, () => ({ path: "x", mimeType: "image/png", hash: "h" }))
      }
    ],
    ["a bad resolution", { prompt: "p", params: { resolution: "8K" } }],
    ["a bad aspect", { prompt: "p", aspect: "21:9" }]
  ])("refuses %s with a terminal 400 before any fetch", async (_label, request) => {
    const fetchMock = stubFetch();
    const error = await rejectionOf(createImageHandler(createTestCtx()).submit(request, {}));
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an unresolved reference before any fetch", async () => {
    const fetchMock = stubFetch();
    const unresolved = { $ref: "s01.face" } as unknown as ImageFile;
    const request = { prompt: "p", refs: [unresolved] };
    await expect(createImageHandler(createTestCtx()).submit(request, {})).rejects.toThrow(
      "[ai] fal image got an unresolved reference.\n  Run the item through app.runner, or pass { path, mimeType, hash } files."
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("needs the key before any upload", async () => {
    const fetchMock = stubFetch();
    const handler = createImageHandler(createTestCtx({ env: createFakeEnv({}) }));
    await expect(handler.submit({ prompt: "p", refs: [face] }, {})).rejects.toThrow(
      "[ai] FAL_KEY is not set."
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("queues a text-to-image job without refs, mapped fields over params", async () => {
    const fetchMock = stubFetch(submitResponse("req-1"));
    const ctx = createTestCtx();
    const request: ImageRequest = {
      prompt: "hero",
      negative: "blur",
      params: { seed: 3, num_images: 4, output_format: "png", quality: "low", resolution: "2K" }
    };

    const { jobId } = await createImageHandler(ctx).submit(request, {});

    const [post] = callsOf(fetchMock);
    expect(post?.url).toBe("https://queue.fal.run/openai/gpt-image-2.5/sunburst/text-to-image");
    expect(jsonBodyOf(post)).toEqual({
      seed: 3,
      prompt: "hero\n\nAvoid: blur",
      image_size: { width: 1152, height: 2048 },
      quality: "low",
      num_images: 1,
      output_format: "jpeg"
    });
    expect(JSON.parse(jobId)).toMatchObject({ requestId: "req-1" });
    expect(ctx.log.info).toHaveBeenCalledWith("fal:image:submitted", {
      model: "gpt-image-2.5",
      endpoint: "openai/gpt-image-2.5/sunburst/text-to-image",
      requestId: "req-1"
    });
  });

  it("uploads refs and queues the edit endpoint with their URLs in order", async () => {
    const fetchMock = stubStorageFetch(submitResponse("req-2"));
    const request: ImageRequest = { prompt: "p", model: "nano-banana-pro", refs: [face, plate] };

    await createImageHandler(createTestCtx()).submit(request, {});

    const post = callsOf(fetchMock).find(call => call.url.startsWith("https://queue.fal.run/"));
    expect(post?.url).toBe("https://queue.fal.run/fal-ai/nano-banana-pro/edit");
    expect(jsonBodyOf(post)).toEqual({
      prompt: "p",
      aspect_ratio: "9:16",
      resolution: "1K",
      num_images: 1,
      output_format: "png",
      enable_web_search: false,
      sync_mode: false,
      image_urls: [storageUrlOf(face), storageUrlOf(plate)]
    });
  });

  it("stops before the queue POST when the caller aborts during the uploads", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (url: string) => {
      if (url === DEFAULT_CONFIG.uploadUrl) {
        return jsonResponse(200, {
          upload_url: "https://upload.fal.test/put/1",
          file_url: "https://cdn.fal.test/1"
        });
      }
      controller.abort(new Error("paused"));
      return okResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const submit = createImageHandler(createTestCtx()).submit(
      { prompt: "p", refs: [face] },
      { signal: controller.signal }
    );

    await expect(submit).rejects.toThrow("paused");
    expect(callsOf(fetchMock).some(call => call.url.startsWith("https://queue.fal.run/"))).toBe(
      false
    );
  });

  it("sends the queue POST without the caller's signal", async () => {
    const controller = new AbortController();
    let postSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        postSignal = init?.signal ?? undefined;
        controller.abort(new Error("late pause"));
        return submitResponse("req-3");
      })
    );

    const { jobId } = await createImageHandler(createTestCtx()).submit(
      { prompt: "p" },
      { signal: controller.signal }
    );

    expect(JSON.parse(jobId)).toMatchObject({ requestId: "req-3" });
    expect(postSignal?.aborted).toBe(false);
  });
});

describe("poll", () => {
  const request: ImageRequest = { prompt: "p" };

  it("is pending while fal works", async () => {
    stubFetch(jsonResponse(200, { status: "IN_PROGRESS" }));
    const poll = await createImageHandler(createTestCtx()).poll(JOB_ID, request, {});
    expect(poll).toEqual({ state: "pending" });
  });

  it("returns the downloaded image with fal's content type, cost and meta", async () => {
    const fetchMock = stubFetch(
      ...finishedJob(
        {
          url: "https://v3.fal.media/files/o.webp",
          content_type: "image/webp",
          width: 1152,
          height: 2048
        },
        bytesResponse(JPEG, "image/jpeg")
      )
    );
    const ctx = createTestCtx();

    const poll = await createImageHandler(ctx).poll(JOB_ID, request, {});

    expect(poll).toEqual({
      state: "done",
      image: JPEG,
      mimeType: "image/webp",
      costUsd: 0.05,
      meta: {
        model: "gpt-image-2.5",
        endpoint: "openai/gpt-image-2.5/sunburst/text-to-image",
        requestId: "req-1",
        width: 1152,
        height: 2048
      }
    });
    expect(callsOf(fetchMock)[2]?.headers.Authorization).toBeUndefined();
    expect(ctx.log.info).toHaveBeenCalledWith("fal:image:done", { requestId: "req-1", bytes: 4 });
  });

  it.each([
    [
      "the download header",
      { url: "https://v3.fal.media/files/o.webp" },
      bytesResponse(JPEG, "image/jpeg"),
      "image/jpeg"
    ],
    [
      "the URL extension",
      { url: "https://v3.fal.media/files/o.webp" },
      new Response(JPEG),
      "image/webp"
    ],
    ["image/png", { url: "https://v3.fal.media/files/o" }, new Response(JPEG), "image/png"]
  ])("falls back to %s for the MIME type", async (_label, image, download, mimeType) => {
    stubFetch(...finishedJob(image, download));
    const poll = await createImageHandler(createTestCtx()).poll(JOB_ID, request, {});
    expect(poll).toMatchObject({ state: "done", mimeType });
    expect(poll.state === "done" && poll.meta).not.toHaveProperty("width");
  });

  it("fails a job fal finished with an error, logged as fal:image:failed", async () => {
    stubFetch(jsonResponse(200, { status: "COMPLETED", error: "bad", error_type: "x" }));
    const ctx = createTestCtx();
    const poll = await createImageHandler(ctx).poll(JOB_ID, request, {});
    expect(poll.state).toBe("failed");
    expect(ctx.log.warn).toHaveBeenCalledWith("fal:image:failed", {
      requestId: "req-1",
      errorType: "terminal",
      status: 400
    });
  });

  it("throws a plain error for a result without images[0].url", async () => {
    stubFetch(jsonResponse(200, { status: "COMPLETED" }), jsonResponse(200, { images: [] }));
    await expect(createImageHandler(createTestCtx()).poll(JOB_ID, request, {})).rejects.toThrow(
      "[ai] fal returned an incomplete image result.\n  Expected images[0].url in the response."
    );
  });
});

describe("execute", () => {
  it("submits, waits in process and returns the image", async () => {
    stubFetch(
      submitResponse("req-1"),
      jsonResponse(200, { status: "IN_QUEUE" }),
      ...finishedJob({ url: "https://v3.fal.media/files/o.jpg" }, bytesResponse(JPEG, "image/jpeg"))
    );

    const result = await createImageHandler(createTestCtx()).execute({ prompt: "p" }, {});

    expect(result).toMatchObject({ image: JPEG, mimeType: "image/jpeg", costUsd: 0.05 });
  });

  it("satisfies the image contract", () => {
    expectTypeOf(createImageHandler(createTestCtx())).toMatchTypeOf<ImageHandler>();
  });
});
