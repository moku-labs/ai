import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { VideoFile, VideoRequest } from "../../../video/contract";
import type { UploadedUrls } from "../../models";
import { buildFalBody, endFrameAliases, falAliases, resolveFalModel } from "../../models";
import { bundledPrices, videoCostUsd } from "../../prices";
import type { EstimateRequest } from "../../types";
import { toDataUri, uploadInputs } from "../../upload";
import { createVideoHandler } from "../../video/handler";
import type { TempFiles } from "./fixtures";
import {
  callsOf,
  createTempFiles,
  createTestCtx,
  initiateCount,
  initiateResponse,
  jsonBodyOf,
  jsonResponse,
  okResponse,
  storageUrlOf,
  stubFetch,
  stubStorageFetch,
  submitResponse,
  TEST_KEY
} from "./fixtures";

const MODEL = "minimax-h3-max-i2v";
const I2V_URL = "https://queue.fal.run/minimax/h3-max/image-to-video";

/** The aliases whose fal schema has `end_image_url`, in catalog order. */
const END_FRAME_ALIASES = [
  "seedance-2.5",
  "minimax-h3",
  "minimax-h3-max-i2v",
  "kling-3-pro",
  "seedance-2.0-mini",
  "vidu-q3",
  "gemini-omni-1.1-flash"
];

const REFUSAL_SECOND_LINE = `\n  Remove input.endImage, or use a model that takes one: ${END_FRAME_ALIASES.join(", ")}.`;

const URLS: UploadedUrls = { image: "u0", refs: [], audioRefs: [], videoRefs: [] };
const WITH_END: UploadedUrls = { ...URLS, endImage: "u9" };
const NO_REFS = { images: [], audio: [], videos: [] };
const OPTIONS = { apiKey: TEST_KEY };

const START_BYTES = new Uint8Array([1, 2, 3]);
const END_BYTES = new Uint8Array([9, 8, 7]);

let temp: TempFiles;
let start: VideoFile;
let end: VideoFile;
let face: VideoFile;
let tail: VideoFile;

beforeAll(() => {
  temp = createTempFiles();
  start = temp.file("start.png", START_BYTES, "image/png", "1".repeat(64));
  end = temp.file("end.png", END_BYTES, "image/png", "9".repeat(64));
  face = temp.file("face.jpg", new Uint8Array([5]), "image/jpeg", "5".repeat(64));
  tail = temp.file("tail.mp4", new Uint8Array([6]), "video/mp4", "6".repeat(64));
});

afterAll(() => {
  temp.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Builds the body for `alias` from the given uploaded URLs and request overrides. */
function bodyFor(
  alias: string,
  urls: UploadedUrls,
  overrides: Partial<VideoRequest> = {}
): Record<string, unknown> {
  return buildFalBody(resolveFalModel(alias), { model: alias, prompt: "p", ...overrides }, urls);
}

/** Submits `request` and returns the error it rejects with, plus the fetch mock it ran against. */
async function rejected(
  request: VideoRequest
): Promise<{ error: Error; fetchMock: ReturnType<typeof vi.fn> }> {
  const fetchMock = stubFetch();
  const error = await createVideoHandler(createTestCtx())
    .submit(request, {})
    .catch((error_: unknown) => error_);
  return { error: error as Error, fetchMock };
}

describe("minimax-h3-max-i2v catalog row", () => {
  it("sits right after minimax-h3-max-ref in catalog order", () => {
    const aliases = falAliases();
    expect(aliases.indexOf(MODEL)).toBe(aliases.indexOf("minimax-h3-max-ref") + 1);
  });

  it("reaches minimax/h3-max/image-to-video at 768P, native audio, end frame, no refs", () => {
    expect(resolveFalModel(MODEL)).toMatchObject({
      alias: MODEL,
      endpoint: "minimax/h3-max/image-to-video",
      resolution: "768P",
      audio: true,
      endFrame: true,
      maxRefs: 0,
      maxAudioRefs: 0,
      maxVideoRefs: 0,
      maxVideoRefSec: 0
    });
  });
});

describe("minimax-h3-max-i2v body", () => {
  it("sends prompt expansion disabled, image_url, integer duration and 768P", () => {
    expect(bodyFor(MODEL, URLS)).toEqual({
      prompt: "p",
      prompt_expansion_mode: "disabled",
      image_url: "u0",
      duration: 5,
      resolution: "768P"
    });
  });

  it("adds end_image_url when the request has an end frame", () => {
    expect(bodyFor(MODEL, WITH_END, { seconds: 8, resolution: "1080P" })).toEqual({
      prompt: "p",
      prompt_expansion_mode: "disabled",
      image_url: "u0",
      end_image_url: "u9",
      duration: 8,
      resolution: "1080P"
    });
  });

  it("lets params switch prompt expansion back on", () => {
    const body = bodyFor(MODEL, URLS, { params: { prompt_expansion_mode: "balanced" } });
    expect(body.prompt_expansion_mode).toBe("balanced");
  });
});

describe("end frame in the model bodies", () => {
  it("exactly seven aliases take an end frame", () => {
    expect(endFrameAliases()).toEqual(END_FRAME_ALIASES);
    expect(falAliases().filter(alias => resolveFalModel(alias).endFrame)).toEqual(
      END_FRAME_ALIASES
    );
  });

  it.each(END_FRAME_ALIASES)("%s: appends end_image_url to the same body", alias => {
    const body = bodyFor(alias, WITH_END);

    expect(body.end_image_url).toBe("u9");
    expect(JSON.stringify(body)).toBe(
      JSON.stringify({ ...bodyFor(alias, URLS), end_image_url: "u9" })
    );
  });

  it.each(END_FRAME_ALIASES)("%s: omits end_image_url without an end frame", alias => {
    expect(bodyFor(alias, URLS)).not.toHaveProperty("end_image_url");
  });

  it("keeps a body without an end frame byte-identical", () => {
    expect(JSON.stringify(bodyFor("minimax-h3", URLS))).toBe(
      '{"prompt":"p","image_url":"u0","duration":5,"resolution":"768P"}'
    );
    expect(JSON.stringify(bodyFor("kling-3-pro", URLS, { negative: "blur" }))).toBe(
      '{"prompt":"p","start_image_url":"u0","duration":"5","generate_audio":false,"negative_prompt":"blur"}'
    );
  });

  it("still merges request.params last, over the end frame", () => {
    const body = bodyFor("vidu-q3", WITH_END, { params: { end_image_url: "u7" } });
    expect(body.end_image_url).toBe("u7");
  });
});

describe("submit with an end frame", () => {
  it("uploads both frames and POSTs image_url and end_image_url to the h3-max i2v endpoint", async () => {
    const fetchMock = stubStorageFetch(submitResponse());

    await createVideoHandler(createTestCtx()).submit(
      { model: MODEL, prompt: "p", image: start, endImage: end },
      {}
    );

    const post = callsOf(fetchMock).find(call => call.url === I2V_URL);
    const body = jsonBodyOf(post);
    expect(post?.method).toBe("POST");
    expect(body.image_url).toBe(storageUrlOf(start));
    expect(body.end_image_url).toBe(storageUrlOf(end));
    expect(body.image_url).not.toBe(body.end_image_url);
    expect(initiateCount(fetchMock)).toBe(2);
  });

  it("sends no end_image_url when the request has no end frame", async () => {
    const fetchMock = stubStorageFetch(submitResponse());

    await createVideoHandler(createTestCtx()).submit(
      { model: MODEL, prompt: "p", image: start },
      {}
    );

    const body = jsonBodyOf(callsOf(fetchMock).find(call => call.url === I2V_URL));
    expect(body).not.toHaveProperty("end_image_url");
    expect(initiateCount(fetchMock)).toBe(1);
  });

  it.each([
    "minimax-h3-max-ref",
    "veo-3.1-fast"
  ])("refuses an end frame on %s before any upload", async alias => {
    const { error, fetchMock } = await rejected({
      model: alias,
      prompt: "p",
      image: start,
      endImage: end
    });

    expect(error.message).toBe(
      `[ai] fal model "${alias}" takes no end frame.${REFUSAL_SECOND_LINE}`
    );
    expect(error.name).toBe("Error");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("uploadInputs — end frame", () => {
  it("uploads the end frame after the refs and returns it as endImage", async () => {
    stubStorageFetch();

    const urls = await uploadInputs(
      createTestCtx(),
      start,
      { images: [face], audio: [], videos: [tail] },
      OPTIONS,
      end
    );

    expect(urls).toEqual({
      image: storageUrlOf(start),
      refs: [storageUrlOf(face)],
      audioRefs: [],
      videoRefs: [storageUrlOf(tail)],
      endImage: storageUrlOf(end)
    });
  });

  it("returns no endImage key without an end frame", async () => {
    stubStorageFetch();

    const urls = await uploadInputs(createTestCtx(), start, NO_REFS, OPTIONS);

    expect(urls).not.toHaveProperty("endImage");
  });

  it("uploads the end frame once and sends it by its cached URL next time", async () => {
    const ctx = createTestCtx();
    const first = stubStorageFetch();
    await uploadInputs(ctx, start, NO_REFS, OPTIONS, end);
    expect(initiateCount(first)).toBe(2);

    const second = stubStorageFetch();
    const urls = await uploadInputs(ctx, start, NO_REFS, OPTIONS, end);

    expect(urls.endImage).toBe(storageUrlOf(end));
    expect(second).not.toHaveBeenCalled();
  });

  it("finds an end frame with the first frame's bytes in the cache", async () => {
    const same = temp.file("same.png", START_BYTES, "image/png", "7".repeat(64));
    const fetchMock = stubStorageFetch();

    const urls = await uploadInputs(createTestCtx(), start, NO_REFS, OPTIONS, same);

    expect(urls.endImage).toBe(storageUrlOf(start));
    expect(initiateCount(fetchMock)).toBe(1);
  });

  it("falls back to a data URI for the end frame when its upload fails", async () => {
    const fetchMock = stubFetch(initiateResponse(1), okResponse(), jsonResponse(500, {}));
    const ctx = createTestCtx();

    const urls = await uploadInputs(ctx, start, NO_REFS, OPTIONS, end);

    expect(urls).toEqual({
      image: "https://cdn.fal.test/file/1",
      refs: [],
      audioRefs: [],
      videoRefs: [],
      endImage: toDataUri(END_BYTES, "image/png")
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(ctx.log.warn).toHaveBeenCalledWith("fal:upload:fallback", { status: 500 });
    expect(ctx.state.uploads.size).toBe(1);
  });

  it("inlines the end frame in data-uri mode", async () => {
    const fetchMock = stubFetch();

    const urls = await uploadInputs(
      createTestCtx({ config: { upload: "data-uri" } }),
      start,
      NO_REFS,
      OPTIONS,
      end
    );

    expect(urls.endImage).toBe(toDataUri(END_BYTES, "image/png"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("minimax-h3-max-i2v price", () => {
  it("bundles per-second prices only, no reference-token keys", () => {
    expect(Object.keys(bundledPrices).filter(key => key.startsWith(`${MODEL}`))).toEqual([
      "minimax-h3-max-i2v@480P",
      "minimax-h3-max-i2v@768P",
      "minimax-h3-max-i2v@1080P"
    ]);
  });

  it.each([
    ["480P", 0.25],
    ["768P", 0.4],
    ["1080P", 0.8]
  ])("prices 5 s at %s at the list rate: %d USD", (resolution, usd) => {
    const request: VideoRequest = { model: MODEL, prompt: "p", image: start, resolution };
    expect(videoCostUsd(createTestCtx(), request)).toBe(usd);
  });

  it("does not charge for the end frame", () => {
    const request: VideoRequest = { model: MODEL, prompt: "p", image: start, endImage: end };

    expect(videoCostUsd(createTestCtx(), request)).toBe(0.4);
    expect(createVideoHandler(createTestCtx()).estimate(request).usd).toBe(0.4);
  });

  it("estimates a request whose endImage is still an unresolved $ref", () => {
    const request: EstimateRequest = {
      model: MODEL,
      prompt: "p",
      image: { $ref: "shot.start" },
      endImage: { $ref: "shot.end" }
    };

    expect(videoCostUsd(createTestCtx(), request)).toBe(0.4);
  });
});
