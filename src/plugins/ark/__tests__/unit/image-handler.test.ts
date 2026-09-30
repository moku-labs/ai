import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageRequest } from "../../../image/contract";
import { RetryableProviderError, TerminalProviderError } from "../../errors";
import {
  ARK_IMAGE_SIZES,
  buildImageBody,
  checkImageRequest,
  imageMimeOf,
  sniffImageMime
} from "../../image/body";
import { createImageHandler } from "../../image/handler";
import {
  arkImageModels,
  DEFAULT_IMAGE_MODEL,
  imageModelsOf,
  resolveArkImageModel
} from "../../image/models";
import {
  bytesResponse,
  callsOf,
  createFakeEnv,
  createTestCtx,
  INTL_IMAGES_URL,
  jpegHeader,
  jsonBodyOf,
  jsonResponse,
  LIVE_ERROR_SEEDREAM_SIZE,
  LIVE_SEEDREAM_RESPONSE,
  loggedText,
  pngHeader,
  SEEDREAM_IMAGE_URL,
  stubFetch,
  TEST_API_KEY
} from "../fixtures";

const PROMPT = "Vertical 9:16 photo. Close-up, Akari at the counter";
const SEEDREAM = resolveArkImageModel(undefined, "intl");
const JPEG = jpegHeader(1440, 2560);

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A request with defaults for everything but the given fields. */
function request(overrides: Partial<ImageRequest> = {}): ImageRequest {
  return { prompt: PROMPT, ...overrides };
}

/** A binary response with no Content-Type header. */
function untypedResponse(bytes: Uint8Array): Response {
  return new Response(bytes, { status: 200 });
}

/** What a promise rejected with. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

describe("image catalog", () => {
  it("has Seedream 5.0 lite on intl at $0.035 with its minimum size", () => {
    expect(arkImageModels).toEqual([
      { id: "seedream-5-0-lite-260128", region: "intl", minPixels: 3_686_400, priceUsd: 0.035 }
    ]);
    expect(DEFAULT_IMAGE_MODEL).toBe("seedream-5-0-lite-260128");
    expect(imageModelsOf("intl")).toEqual(["seedream-5-0-lite-260128"]);
    expect(imageModelsOf("cn")).toEqual([]);
  });

  it("refuses an unknown id, and any id on a region without image models", () => {
    expect(() => resolveArkImageModel("seedream-4", "intl")).toThrow(
      '[ai] Unknown ark image model "seedream-4".\n  Known: seedream-5-0-lite-260128.'
    );
    expect(() => resolveArkImageModel(undefined, "cn")).toThrow(
      '[ai] Unknown ark image model "seedream-5-0-lite-260128".\n  Known: none in region cn.'
    );
  });
});

describe("image body", () => {
  it("sends a size of at least the minimum for each aspect", () => {
    expect(ARK_IMAGE_SIZES).toEqual({
      "9:16": "1440x2560",
      "16:9": "2560x1440",
      "1:1": "2048x2048",
      "3:4": "1728x2304",
      "4:3": "2304x1728"
    });
    for (const [aspect, size] of Object.entries(ARK_IMAGE_SIZES)) {
      const [width, height] = size.split("x").map(Number);
      expect((width ?? 0) * (height ?? 0)).toBeGreaterThanOrEqual(SEEDREAM.minPixels);
      expect(checkImageRequest(SEEDREAM, request({ aspect })).size).toBe(size);
    }
    expect(checkImageRequest(SEEDREAM, request()).size).toBe("1440x2560");
  });

  it("refuses another aspect, listing the table", () => {
    expect(() => checkImageRequest(SEEDREAM, request({ aspect: "21:9" }))).toThrow(
      '[ai] ark image aspect "21:9" is not supported.\n  Use one of: 9:16, 16:9, 1:1, 3:4, 4:3.'
    );
  });

  it("lets params.size win, and refuses a size below the minimum or of another shape", () => {
    expect(checkImageRequest(SEEDREAM, request({ params: { size: "1600x2848" } })).size).toBe(
      "1600x2848"
    );
    expect(() => checkImageRequest(SEEDREAM, request({ params: { size: "1152x2048" } }))).toThrow(
      "[ai] ark image size 1152x2048 is below 3686400 pixels.\n  Use at least 1440x2560 for 9:16."
    );
    expect(() =>
      checkImageRequest(SEEDREAM, request({ aspect: "16:9", params: { size: "1920x1080" } }))
    ).toThrow("Use at least 2560x1440 for 16:9.");
    expect(() => checkImageRequest(SEEDREAM, request({ params: { size: "2K" } }))).toThrow(
      '[ai] ark params.size must be "<width>x<height>".\n  Pass it like "1440x2560".'
    );
    expect(() => checkImageRequest(SEEDREAM, request({ params: { size: 2048 } }))).toThrow(
      'ark params.size must be "<width>x<height>".'
    );
  });

  it("refuses refs and unknown params", () => {
    const ref = { path: "a.png", mimeType: "image/png", hash: "h" };
    expect(() => checkImageRequest(SEEDREAM, request({ refs: [ref] }))).toThrow(
      "[ai] ark images are text-to-image only.\n  Remove input.refs."
    );
    expect(() => checkImageRequest(SEEDREAM, request({ params: { style: "anime" } }))).toThrow(
      '[ai] Unknown ark image param "style".\n  Allowed: size, seed, generation, watermark.'
    );
  });

  it("builds the body with seed and watermark as given, never generation", () => {
    const checked = checkImageRequest(
      SEEDREAM,
      request({ params: { seed: 7, watermark: true, generation: 2 } })
    );
    expect(buildImageBody(SEEDREAM, PROMPT, checked)).toEqual({
      model: DEFAULT_IMAGE_MODEL,
      prompt: PROMPT,
      size: "1440x2560",
      response_format: "url",
      watermark: true,
      seed: 7
    });
  });

  it("names the bytes from Content-Type, else from their signature", () => {
    expect(imageMimeOf("image/jpeg; charset=binary", pngHeader(1, 1))).toBe("image/jpeg");
    expect(imageMimeOf(new Headers().get("content-type"), pngHeader(1, 1))).toBe("image/png");
    expect(imageMimeOf("application/octet-stream", JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
    expect(sniffImageMime(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageMime(new Uint8Array([1, 2, 3]))).toBe("application/octet-stream");
  });
});

describe("image handler: estimate", () => {
  it("is one image at the catalog price, with no key and no call", () => {
    const fetchMock = stubFetch();
    const handler = createImageHandler(createTestCtx({ env: createFakeEnv({}) }));

    expect(handler.estimate(request())).toEqual({ usd: 0.035 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses priceOverrides as USD per image", () => {
    const handler = createImageHandler(
      createTestCtx({ config: { priceOverrides: { [DEFAULT_IMAGE_MODEL]: 0.02 } } })
    );
    expect(handler.estimate(request())).toEqual({ usd: 0.02 });
  });

  it("fails at plan time with the execute errors", () => {
    const handler = createImageHandler(createTestCtx());
    expect(() => handler.estimate(request({ model: "nope" }))).toThrow(
      'Unknown ark image model "nope"'
    );
    expect(() => handler.estimate(request({ params: { size: "1152x2048" } }))).toThrow(
      "is below 3686400 pixels."
    );
  });
});

describe("image handler: execute", () => {
  it("POSTs the exact Seedream body with the Bearer key, then downloads without it", async () => {
    const fetchMock = stubFetch(
      jsonResponse(200, LIVE_SEEDREAM_RESPONSE),
      bytesResponse(JPEG, "image/jpeg")
    );
    const ctx = createTestCtx();

    const result = await createImageHandler(ctx).execute(request({ aspect: "9:16" }), {});

    const [generate, download] = callsOf(fetchMock);
    expect(generate?.url).toBe(INTL_IMAGES_URL);
    expect(generate?.method).toBe("POST");
    expect(generate?.headers.Authorization).toBe(`Bearer ${TEST_API_KEY}`);
    expect(jsonBodyOf(generate)).toEqual({
      model: "seedream-5-0-lite-260128",
      prompt: PROMPT,
      size: "1440x2560",
      response_format: "url",
      watermark: false
    });
    expect(download?.url).toBe(SEEDREAM_IMAGE_URL);
    expect(download?.method).toBe("GET");
    expect(download?.headers.Authorization).toBeUndefined();
    expect(result).toEqual({
      image: JPEG,
      mimeType: "image/jpeg",
      costUsd: 0.035,
      meta: { model: "seedream-5-0-lite-260128", size: "1440x2560" }
    });
    expect(ctx.log.info).toHaveBeenCalledWith("ark:image:done", {
      model: "seedream-5-0-lite-260128",
      bytes: JPEG.length
    });
  });

  it("returns the downloaded bytes unchanged, byte for byte", async () => {
    const original = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7, 0, 255, 128, 3, 0xff, 0xd9]);
    stubFetch(jsonResponse(200, LIVE_SEEDREAM_RESPONSE), bytesResponse(original, "image/jpeg"));

    const result = await createImageHandler(createTestCtx()).execute(request(), {});

    expect(result.image).toEqual(original);
    expect(result.image.byteLength).toBe(original.byteLength);
  });

  it("sniffs the MIME type when the download has no Content-Type", async () => {
    stubFetch(jsonResponse(200, LIVE_SEEDREAM_RESPONSE), untypedResponse(pngHeader(1440, 2560)));

    const result = await createImageHandler(createTestCtx()).execute(request(), {});

    expect(result.mimeType).toBe("image/png");
  });

  it("downloads with downloadTimeoutMs and generates with timeoutMs", async () => {
    stubFetch(jsonResponse(200, LIVE_SEEDREAM_RESPONSE), bytesResponse(JPEG, "image/jpeg"));
    const timeout = vi.spyOn(AbortSignal, "timeout");

    await createImageHandler(createTestCtx()).execute(request(), {});

    expect(timeout.mock.calls).toEqual([[60_000], [300_000]]);
    timeout.mockRestore();
  });

  it("prices every generated image of usage", async () => {
    const two = { ...LIVE_SEEDREAM_RESPONSE, usage: { generated_images: 2 } };
    stubFetch(jsonResponse(200, two), bytesResponse(JPEG, "image/jpeg"));

    const result = await createImageHandler(createTestCtx()).execute(request(), {});

    expect(result.costUsd).toBe(0.07);
  });

  it("fails before any fetch for a size below the minimum, refs, or a missing key", async () => {
    const ref = { path: "a.png", mimeType: "image/png", hash: "h" };
    const cases: Array<[ReturnType<typeof createTestCtx>, ImageRequest, string]> = [
      [createTestCtx(), request({ params: { size: "1152x2048" } }), "is below 3686400 pixels."],
      [createTestCtx(), request({ refs: [ref] }), "ark images are text-to-image only."],
      [createTestCtx({ env: createFakeEnv({}) }), request(), 'required variable "ARK_API_KEY"']
    ];
    for (const [ctx, input, message] of cases) {
      const fetchMock = stubFetch();
      const error = await rejectionOf(createImageHandler(ctx).execute(input, {}));
      expect(error.message).toContain(message);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("maps the live 400 size error to terminal with ark's code and message", async () => {
    stubFetch(jsonResponse(400, LIVE_ERROR_SEEDREAM_SIZE));

    const error = await rejectionOf(
      createImageHandler(createTestCtx()).execute(request({ params: { size: "1440x2560" } }), {})
    );

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({ status: 400, code: "InvalidParameter" });
    expect(error.message).toContain("image size must be at least 3686400 pixels");
  });

  it("throws retryable 502 when the response has no data[0].url", async () => {
    for (const body of [{ data: [] }, { data: "none" }, {}]) {
      stubFetch(jsonResponse(200, body));

      const error = await rejectionOf(createImageHandler(createTestCtx()).execute(request(), {}));

      expect(error).toBeInstanceOf(RetryableProviderError);
      expect(error).toMatchObject({ status: 502 });
    }
  });

  it("prices one image when the response has no usage", async () => {
    stubFetch(
      jsonResponse(200, { data: [{ url: SEEDREAM_IMAGE_URL }] }),
      bytesResponse(JPEG, "image/jpeg")
    );

    const result = await createImageHandler(createTestCtx()).execute(request(), {});

    expect(result.costUsd).toBe(0.035);
  });

  it("does not POST when the caller aborted before the call", async () => {
    const fetchMock = stubFetch();
    const controller = new AbortController();
    controller.abort(new Error("paused"));

    await expect(
      createImageHandler(createTestCtx()).execute(request(), { signal: controller.signal })
    ).rejects.toThrow("paused");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops negative with one ark:negative:ignored warning per process", async () => {
    const fetchMock = stubFetch(
      jsonResponse(200, LIVE_SEEDREAM_RESPONSE),
      bytesResponse(JPEG, "image/jpeg"),
      jsonResponse(200, LIVE_SEEDREAM_RESPONSE),
      bytesResponse(JPEG, "image/jpeg")
    );
    const ctx = createTestCtx();
    const handler = createImageHandler(ctx);

    await handler.execute(request({ negative: "blur" }), {});
    await handler.execute(request({ negative: "blur" }), {});

    expect(JSON.stringify(jsonBodyOf(callsOf(fetchMock)[0]))).not.toContain("blur");
    const warnings = vi
      .mocked(ctx.log.warn)
      .mock.calls.filter(([event]) => event === "ark:negative:ignored");
    expect(warnings).toEqual([["ark:negative:ignored", { model: DEFAULT_IMAGE_MODEL }]]);
    expect(ctx.state.imageNegativeWarned).toBe(true);
  });

  it("never logs the prompt, the key or a URL", async () => {
    stubFetch(jsonResponse(200, LIVE_SEEDREAM_RESPONSE), bytesResponse(JPEG, "image/jpeg"));
    const ctx = createTestCtx();

    await createImageHandler(ctx).execute(request({ negative: "blur" }), {});

    const logged = loggedText(ctx);
    expect(logged).not.toContain(PROMPT);
    expect(logged).not.toContain(TEST_API_KEY);
    expect(logged).not.toContain("https://");
  });
});
