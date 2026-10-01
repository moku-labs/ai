import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageFile, ImageRequest } from "../../../image/contract";
import { RetryableProviderError } from "../../errors";
import { ARK_IMAGE_PARAMS, buildImageBody, checkImageRequest } from "../../image/body";
import { createImageHandler } from "../../image/handler";
import { arkImageModels, resolveArkImageModel } from "../../image/models";
import {
  bytesResponse,
  callsOf,
  createTestCtx,
  INTL_IMAGES_URL,
  jsonBodyOf,
  jsonResponse,
  SEEDREAM_GROUP_ERROR_ENTRY,
  SEEDREAM_GROUP_RESPONSE,
  SEEDREAM_GROUP_URLS,
  TEST_API_KEY
} from "../fixtures";

const PROMPT = "Four panels of Akari baking, same apron, same kitchen";
const SEEDREAM = resolveArkImageModel(undefined, "intl");
const IMAGES_ERROR =
  "[ai] ark params.images must be a whole number from 1 to 15.\n  Pass it like 6.";

/** The text-to-image body of today: what a request without `params.images` sends. */
const SINGLE_BODY = {
  model: "seedream-5-0-lite-260128",
  prompt: PROMPT,
  size: "1440x2560",
  response_format: "url",
  watermark: false
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A request with defaults for everything but the given fields. */
function request(overrides: Partial<ImageRequest> = {}): ImageRequest {
  return { prompt: PROMPT, ...overrides };
}

/** `count` copies of one unread ref (the checks read only the count). */
function refsOf(count: number): ImageFile[] {
  return Array.from({ length: count }, () => ({ path: "a.png", mimeType: "image/png", hash: "h" }));
}

/** JPEG bytes that carry their position `n`, so order is visible. */
function jpegNumber(n: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n]);
}

/** Group URL `n` (1-based). */
function groupUrl(n: number): string {
  return `https://example.invalid/group-${n}.jpeg`;
}

/** A group response with `count` urls and the given usage. */
function groupResponse(count: number, usage?: { generated_images: number }): unknown {
  const data = Array.from({ length: count }, (_, index) => ({
    url: groupUrl(index + 1),
    size: "1440x2560"
  }));
  return usage === undefined ? { data } : { data, usage };
}

/**
 * Stubs fetch by URL: the generation answers `body`; each group URL answers
 * its numbered JPEG. Anything else fails the test.
 */
function stubSeedream(body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === INTL_IMAGES_URL) return jsonResponse(200, body);
    const match = /group-(\d+)\.jpeg$/.exec(url);
    if (match) return bytesResponse(jpegNumber(Number(match[1])), "image/jpeg");
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
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

describe("image group: catalog and params", () => {
  it("counts at most 15 images per group request, refs included", () => {
    expect(arkImageModels.map(model => model.maxGroupImages)).toEqual([15]);
    expect(SEEDREAM.maxGroupImages).toBe(15);
  });

  it("takes images as a param", () => {
    expect(ARK_IMAGE_PARAMS).toEqual(["size", "seed", "generation", "watermark", "images"]);
  });
});

describe("image group: checks", () => {
  it.each<[string, unknown]>([
    ["0", 0],
    ["1.5", 1.5],
    ['"6"', "6"],
    ["16", 16],
    ["-1", -1]
  ])("refuses params.images %s", (_name, images) => {
    expect(() => checkImageRequest(SEEDREAM, request({ params: { images } }))).toThrow(
      IMAGES_ERROR
    );
  });

  it("takes 1 to 15 images", () => {
    expect(checkImageRequest(SEEDREAM, request({ params: { images: 1 } })).images).toBe(1);
    expect(checkImageRequest(SEEDREAM, request({ params: { images: 15 } })).images).toBe(15);
    expect(checkImageRequest(SEEDREAM, request()).images).toBeUndefined();
  });

  it("refuses refs plus images over 15, and takes 15", () => {
    expect(() =>
      checkImageRequest(SEEDREAM, request({ refs: refsOf(14), params: { images: 2 } }))
    ).toThrow(
      '[ai] ark image model "seedream-5-0-lite-260128" makes at most 15 images including refs, got 14 refs + 2 images.\n  Set params.images to 1 or less, or remove refs.'
    );
    expect(
      checkImageRequest(SEEDREAM, request({ refs: refsOf(13), params: { images: 2 } })).images
    ).toBe(2);
  });

  it("checks the ref count first", () => {
    expect(() =>
      checkImageRequest(SEEDREAM, request({ refs: refsOf(15), params: { images: 0 } }))
    ).toThrow("takes at most 14 reference images, got 15.");
  });
});

describe("image group: body", () => {
  it("is today's body, key for key, without params.images", () => {
    const body = buildImageBody(SEEDREAM, PROMPT, checkImageRequest(SEEDREAM, request()), []);

    expect(body).toStrictEqual(SINGLE_BODY);
    expect(Object.keys(body)).toEqual(Object.keys(SINGLE_BODY));
  });

  it("asks for a group of params.images", () => {
    const checked = checkImageRequest(SEEDREAM, request({ params: { images: 6 } }));

    expect(buildImageBody(SEEDREAM, PROMPT, checked, [])).toStrictEqual({
      ...SINGLE_BODY,
      sequential_image_generation: "auto",
      sequential_image_generation_options: { max_images: 6 }
    });
  });

  it("keeps the refs next to the group fields", () => {
    const checked = checkImageRequest(
      SEEDREAM,
      request({ refs: refsOf(2), params: { images: 4 } })
    );
    const refs = ["data:image/png;base64,AQID", "data:image/jpeg;base64,BAUG"];

    expect(buildImageBody(SEEDREAM, PROMPT, checked, refs)).toStrictEqual({
      ...SINGLE_BODY,
      image: refs,
      sequential_image_generation: "auto",
      sequential_image_generation_options: { max_images: 4 }
    });
  });
});

describe("image group: estimate", () => {
  it("prices params.images images: an upper bound", () => {
    const handler = createImageHandler(createTestCtx());

    expect(handler.estimate(request({ params: { images: 6 } }))).toEqual({ usd: 0.21 });
    expect(handler.estimate(request())).toEqual({ usd: 0.035 });
  });

  it("fails at plan time with the group errors", () => {
    const handler = createImageHandler(createTestCtx());

    expect(() => handler.estimate(request({ params: { images: 16 } }))).toThrow(IMAGES_ERROR);
  });
});

describe("image group: execute", () => {
  it("downloads every url in order and prices every generated image", async () => {
    const fetchMock = stubSeedream(SEEDREAM_GROUP_RESPONSE);
    const ctx = createTestCtx();

    const result = await createImageHandler(ctx).execute(request({ params: { images: 3 } }), {});

    const [generate, ...downloads] = callsOf(fetchMock);
    expect(generate?.headers.Authorization).toBe(`Bearer ${TEST_API_KEY}`);
    expect(jsonBodyOf(generate)).toStrictEqual({
      ...SINGLE_BODY,
      sequential_image_generation: "auto",
      sequential_image_generation_options: { max_images: 3 }
    });
    expect(downloads.map(call => call.url)).toEqual([...SEEDREAM_GROUP_URLS]);
    for (const call of downloads) {
      expect(call.method).toBe("GET");
      expect(call.headers.Authorization).toBeUndefined();
    }
    expect(result).toEqual({
      image: jpegNumber(1),
      mimeType: "image/jpeg",
      images: [1, 2, 3].map(n => ({ image: jpegNumber(n), mimeType: "image/jpeg" })),
      costUsd: 0.105,
      meta: {
        model: "seedream-5-0-lite-260128",
        size: "1440x2560",
        imagesRequested: 3,
        imagesReturned: 3
      }
    });
    expect(ctx.log.info).toHaveBeenCalledWith("ark:image:done", {
      model: "seedream-5-0-lite-260128",
      bytes: 15,
      images: 3
    });
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it("returns a short group with a warning, priced by the images made", async () => {
    stubSeedream(groupResponse(4, { generated_images: 4 }));
    const ctx = createTestCtx();

    const result = await createImageHandler(ctx).execute(request({ params: { images: 6 } }), {});

    expect(result.images).toHaveLength(4);
    expect(result.meta).toMatchObject({ imagesRequested: 6, imagesReturned: 4 });
    expect(result.costUsd).toBe(0.14);
    expect(ctx.log.warn).toHaveBeenCalledWith("ark:image:group-short", {
      model: "seedream-5-0-lite-260128",
      requested: 6,
      returned: 4
    });
  });

  it("prices the returned images when the response has no usage", async () => {
    stubSeedream(groupResponse(2));

    const result = await createImageHandler(createTestCtx()).execute(
      request({ params: { images: 2 } }),
      {}
    );

    expect(result.costUsd).toBe(0.07);
  });

  it("skips a data entry without a url, such as an error entry", async () => {
    const fetchMock = stubSeedream({
      data: [{ url: groupUrl(1) }, SEEDREAM_GROUP_ERROR_ENTRY, { url: groupUrl(3) }],
      usage: { generated_images: 2 }
    });
    const ctx = createTestCtx();

    const result = await createImageHandler(ctx).execute(request({ params: { images: 3 } }), {});

    expect(callsOf(fetchMock).map(call => call.url)).toEqual([
      INTL_IMAGES_URL,
      groupUrl(1),
      groupUrl(3)
    ]);
    expect(result.images?.map(output => output.image)).toEqual([jpegNumber(1), jpegNumber(3)]);
    expect(result.costUsd).toBe(0.07);
    expect(ctx.log.warn).toHaveBeenCalledWith("ark:image:group-short", {
      model: "seedream-5-0-lite-260128",
      requested: 3,
      returned: 2
    });
  });

  it("throws retryable 502 when no entry has a url, and downloads nothing", async () => {
    for (const body of [{ data: [SEEDREAM_GROUP_ERROR_ENTRY] }, { data: [] }, {}]) {
      const fetchMock = stubSeedream(body);

      const error = await rejectionOf(
        createImageHandler(createTestCtx()).execute(request({ params: { images: 3 } }), {})
      );

      expect(error).toBeInstanceOf(RetryableProviderError);
      expect(error).toMatchObject({ status: 502 });
      expect(callsOf(fetchMock)).toHaveLength(1);
    }
  });

  it("keeps a group of one a group: images has one entry", async () => {
    stubSeedream(groupResponse(1, { generated_images: 1 }));

    const result = await createImageHandler(createTestCtx()).execute(
      request({ params: { images: 1 } }),
      {}
    );

    expect(result.images).toEqual([{ image: jpegNumber(1), mimeType: "image/jpeg" }]);
    expect(result.meta).toMatchObject({ imagesRequested: 1, imagesReturned: 1 });
  });

  it("fails before any fetch for a bad params.images or too many images with refs", async () => {
    const cases: Array<[ImageRequest, string]> = [
      [request({ params: { images: 16 } }), IMAGES_ERROR],
      [
        request({ refs: refsOf(14), params: { images: 2 } }),
        "makes at most 15 images including refs"
      ]
    ];
    for (const [input, message] of cases) {
      const fetchMock = stubSeedream(SEEDREAM_GROUP_RESPONSE);

      const error = await rejectionOf(createImageHandler(createTestCtx()).execute(input, {}));

      expect(error.message).toContain(message);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });
});
