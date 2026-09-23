import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { VideoFile, VideoRequest } from "../../../video/contract";
import { buildFalBody, resolveFalModel } from "../../models";
import { uploadInputs } from "../../upload";
import { createVideoHandler } from "../../video/handler";
import type { TempFiles } from "./fixtures";
import {
  callsOf,
  createTempFiles,
  createTestCtx,
  initiateResponse,
  jsonBodyOf,
  okResponse,
  stubFetch,
  submitResponse,
  TEST_KEY
} from "./fixtures";

const SECOND_LINE = "\n  Remove refs from input.refs, or use a model that takes more.";

let temp: TempFiles;
let image: VideoFile;
let face: VideoFile;
let voice: VideoFile;

beforeAll(() => {
  temp = createTempFiles();
  image = temp.file("key.png", new Uint8Array([1]), "image/png", "1".repeat(64));
  face = temp.file("face.png", new Uint8Array([2]), "image/png", "2".repeat(64));
  voice = temp.file("voice.mp3", new Uint8Array([3]), "audio/mpeg", "3".repeat(64));
});

afterAll(() => {
  temp.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Submits `request` in data-URI mode and returns the POSTed URL and body. */
async function submitted(
  request: VideoRequest
): Promise<{ url: string; body: Record<string, unknown> }> {
  const fetchMock = stubFetch(submitResponse());
  await createVideoHandler(createTestCtx({ config: { upload: "data-uri" } })).submit(request, {});
  const call = callsOf(fetchMock)[0];
  return { url: call?.url ?? "", body: jsonBodyOf(call) };
}

/** The rejection of submitting `request`, with the fetch mock it ran against. */
async function rejected(
  request: VideoRequest
): Promise<{ message: string; fetchMock: ReturnType<typeof vi.fn> }> {
  const fetchMock = stubFetch();
  const error = await createVideoHandler(createTestCtx())
    .submit(request, {})
    .catch((error_: unknown) => error_);
  return { message: (error as Error).message, fetchMock };
}

describe("minimax-h3-max-ref body", () => {
  it("leads reference_image_urls with the first frame and sends the schema's fields", () => {
    const body = buildFalBody(
      resolveFalModel("minimax-h3-max-ref"),
      { model: "minimax-h3-max-ref", prompt: "<d>[Japanese] こんにちは</d>" },
      { image: "u0", refs: ["u1"], audioRefs: [] }
    );
    expect(body).toEqual({
      prompt: "<d>[Japanese] こんにちは</d>",
      prompt_expansion_mode: "balanced",
      reference_image_urls: ["u0", "u1"],
      duration: 5,
      resolution: "768P",
      aspect_ratio: "9:16"
    });
  });

  it("posts audio refs as reference_audio_urls to the h3-max endpoint", async () => {
    const { url, body } = await submitted({
      model: "minimax-h3-max-ref",
      prompt: "p",
      image,
      refs: [face, voice]
    });

    expect(url).toBe("https://queue.fal.run/minimax/h3-max/reference-to-video");
    expect(body.reference_image_urls).toHaveLength(2);
    expect(body.reference_audio_urls).toEqual([expect.stringMatching(/^data:audio\/mpeg;base64,/)]);
  });

  it("takes 8 image refs besides the first frame and rejects a 9th", async () => {
    const eight = Array.from({ length: 8 }, () => face);
    const { body } = await submitted({
      model: "minimax-h3-max-ref",
      prompt: "p",
      image,
      refs: eight
    });
    expect(body.reference_image_urls).toHaveLength(9);

    const { message, fetchMock } = await rejected({
      model: "minimax-h3-max-ref",
      prompt: "p",
      image,
      refs: [...eight, face]
    });
    expect(message).toBe(
      `[ai] fal model "minimax-h3-max-ref" takes at most 8 reference images, got 9.${SECOND_LINE}`
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a 4th audio ref", async () => {
    const { message } = await rejected({
      model: "minimax-h3-max-ref",
      prompt: "p",
      image,
      refs: [voice, voice, voice, voice]
    });
    expect(message).toBe(
      `[ai] fal model "minimax-h3-max-ref" takes at most 3 reference audio files, got 4.${SECOND_LINE}`
    );
  });
});

describe("seedance-2.5-ref audio refs", () => {
  it("sends audio refs as audio_urls, apart from image_urls", async () => {
    const { body } = await submitted({
      model: "seedance-2.5-ref",
      prompt: "p",
      image,
      refs: [face, voice]
    });

    expect(body.image_urls).toEqual([
      expect.stringMatching(/^data:image\/png;base64,/),
      expect.stringMatching(/^data:image\/png;base64,/)
    ]);
    expect(body.audio_urls).toEqual([expect.stringMatching(/^data:audio\/mpeg;base64,/)]);
  });

  it("omits audio_urls without audio refs", async () => {
    const { body } = await submitted({
      model: "seedance-2.5-ref",
      prompt: "p",
      image,
      refs: [face]
    });
    expect(body).not.toHaveProperty("audio_urls");
  });

  it("rejects an 11th audio ref", async () => {
    const eleven = Array.from({ length: 11 }, () => voice);
    const { message } = await rejected({
      model: "seedance-2.5-ref",
      prompt: "p",
      image,
      refs: eleven
    });
    expect(message).toBe(
      `[ai] fal model "seedance-2.5-ref" takes at most 10 reference audio files, got 11.${SECOND_LINE}`
    );
  });
});

describe("audio refs on a model without audio refs", () => {
  it("fails before any fetch", async () => {
    const { message, fetchMock } = await rejected({
      model: "kling-o3-ref",
      prompt: "p",
      image,
      refs: [voice]
    });
    expect(message).toBe(
      `[ai] fal model "kling-o3-ref" takes no reference audio, got 1.${SECOND_LINE}`
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("uploadInputs — audio refs", () => {
  it("uploads audio refs after image refs and returns them as audioRefs", async () => {
    const fetchMock = stubFetch(
      initiateResponse(1),
      okResponse(),
      initiateResponse(2),
      okResponse(),
      initiateResponse(3),
      okResponse()
    );

    const urls = await uploadInputs(
      createTestCtx(),
      image,
      { images: [face], audio: [voice] },
      { apiKey: TEST_KEY }
    );

    expect(urls).toEqual({
      image: "https://cdn.fal.test/file/1",
      refs: ["https://cdn.fal.test/file/2"],
      audioRefs: ["https://cdn.fal.test/file/3"]
    });
    expect(jsonBodyOf(callsOf(fetchMock)[4])).toMatchObject({ content_type: "audio/mpeg" });
  });
});
