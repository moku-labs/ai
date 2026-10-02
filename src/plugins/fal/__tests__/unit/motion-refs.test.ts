import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { VideoFile, VideoRequest } from "../../../video/contract";
import { createVideoHandler, splitReferences } from "../../video/handler";
import { buildFalBody, resolveFalModel } from "../../video/models";
import { videoPrices as bundledPrices, videoCostUsd } from "../../video/prices";
import type { TempFiles } from "./fixtures";
import { createTempFiles, createTestCtx, pngHeader, stubFetch } from "./fixtures";

const SECOND_LINE = "\n  Remove refs from input.refs, or use a model that takes more.";

let temp: TempFiles;
let image: VideoFile;
let face: VideoFile;
let motion: VideoFile;

beforeAll(() => {
  temp = createTempFiles();
  image = temp.file("key.png", pngHeader(64, 64), "image/png", "1".repeat(64));
  face = temp.file("face.png", new Uint8Array([2]), "image/png", "2".repeat(64));
  motion = temp.file("motion.mp4", new Uint8Array([4]), "video/mp4", "4".repeat(64));
});

afterAll(() => {
  temp.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The error message of submitting `request`, with the fetch mock it ran against. */
async function rejected(
  request: VideoRequest
): Promise<{ message: string; fetchMock: ReturnType<typeof vi.fn> }> {
  const fetchMock = stubFetch();
  const error = await createVideoHandler(createTestCtx())
    .submit(request, {})
    .catch((error_: unknown) => error_);
  return { message: (error as Error).message, fetchMock };
}

describe("catalog limits of the motion-reference models", () => {
  it("wan-3.0-ref: 9 image refs, 5 audio refs, 5 video refs, 15 s of video refs", () => {
    expect(resolveFalModel("wan-3.0-ref")).toMatchObject({
      endpoint: "alibaba/wan-3.0/reference-to-video",
      resolution: "720p",
      audio: true,
      endFrame: false,
      maxRefs: 9,
      maxAudioRefs: 5,
      maxVideoRefs: 5,
      maxVideoRefSec: 15
    });
  });

  it("kling-o3-v2v-ref: 3 image refs, no audio refs, 1 video ref of up to 15 s", () => {
    const model = resolveFalModel("kling-o3-v2v-ref");
    expect(model).toMatchObject({
      endpoint: "fal-ai/kling-video/o3/pro/video-to-video/reference",
      audio: false,
      endFrame: false,
      maxRefs: 3,
      maxAudioRefs: 0,
      maxVideoRefs: 1,
      maxVideoRefSec: 15
    });
    expect(model.resolution).toBeUndefined();
  });

  it("kling-o3-ref: 4 image refs, no audio refs, no video refs", () => {
    expect(resolveFalModel("kling-o3-ref")).toMatchObject({
      endpoint: "fal-ai/kling-video/o3/pro/reference-to-video",
      audio: true,
      endFrame: false,
      maxRefs: 4,
      maxAudioRefs: 0,
      maxVideoRefs: 0,
      maxVideoRefSec: 0
    });
  });
});

describe("wan-3.0-ref video refs", () => {
  it("sends reference_video_urls when there are video refs", () => {
    const body = buildFalBody(
      resolveFalModel("wan-3.0-ref"),
      { model: "wan-3.0-ref", prompt: "the subject in Image 1 moves like Video 1" },
      { image: "u0", refs: ["r1"], audioRefs: [], videoRefs: ["v1", "v2"] }
    );
    expect(body.reference_image_urls).toEqual(["u0", "r1"]);
    expect(body.reference_video_urls).toEqual(["v1", "v2"]);
    expect(body).not.toHaveProperty("reference_audio_urls");
  });

  it("sends no reference_video_urls without video refs", () => {
    const body = buildFalBody(
      resolveFalModel("wan-3.0-ref"),
      { model: "wan-3.0-ref", prompt: "p" },
      { image: "u0", refs: [], audioRefs: [], videoRefs: [] }
    );
    expect(body).not.toHaveProperty("reference_video_urls");
  });

  it("takes 5 video refs", () => {
    const split = splitReferences(resolveFalModel("wan-3.0-ref"), Array(5).fill(motion));
    expect(split.videos).toHaveLength(5);
  });

  it("rejects a 6th video ref before any fetch", async () => {
    const { message, fetchMock } = await rejected({
      model: "wan-3.0-ref",
      prompt: "p",
      image,
      refs: Array(6).fill(motion)
    });
    expect(message).toBe(
      `[ai] fal model "wan-3.0-ref" takes at most 5 video references, got 6.${SECOND_LINE}`
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("kling-o3-v2v-ref", () => {
  it("sends the video ref as video_url, the first frame leading image_urls, keep_audio off", () => {
    const body = buildFalBody(
      resolveFalModel("kling-o3-v2v-ref"),
      { model: "kling-o3-v2v-ref", prompt: "@Image1 moves like @Video1", seconds: 8, audio: true },
      { image: "u0", refs: ["r1", "r2"], audioRefs: [], videoRefs: ["v1"] }
    );
    expect(body).toEqual({
      prompt: "@Image1 moves like @Video1",
      video_url: "v1",
      image_urls: ["u0", "r1", "r2"],
      duration: "8",
      aspect_ratio: "9:16",
      keep_audio: false
    });
  });

  it("lets params turn keep_audio on and set elements", () => {
    const elements = [{ frontal_image_url: "f1" }];
    const body = buildFalBody(
      resolveFalModel("kling-o3-v2v-ref"),
      { model: "kling-o3-v2v-ref", prompt: "p", params: { keep_audio: true, elements } },
      { image: "u0", refs: [], audioRefs: [], videoRefs: ["v1"] }
    );
    expect(body.keep_audio).toBe(true);
    expect(body.elements).toEqual(elements);
  });

  it("sends no video_url without a video ref", () => {
    const body = buildFalBody(
      resolveFalModel("kling-o3-v2v-ref"),
      { model: "kling-o3-v2v-ref", prompt: "p" },
      { image: "u0", refs: [], audioRefs: [], videoRefs: [] }
    );
    expect(body).not.toHaveProperty("video_url");
  });

  it("rejects a 2nd video ref before any fetch", async () => {
    const { message, fetchMock } = await rejected({
      model: "kling-o3-v2v-ref",
      prompt: "p",
      image,
      refs: [motion, motion]
    });
    expect(message).toBe(
      `[ai] fal model "kling-o3-v2v-ref" takes at most 1 video references, got 2.${SECOND_LINE}`
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a 4th image ref: the first frame takes one of the 4 image_urls", async () => {
    const { message, fetchMock } = await rejected({
      model: "kling-o3-v2v-ref",
      prompt: "p",
      image,
      refs: [face, face, face, face, motion]
    });
    expect(message).toBe(
      `[ai] fal model "kling-o3-v2v-ref" takes at most 3 reference images, got 4.${SECOND_LINE}`
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("takes 3 image refs and 1 video ref: 4 image_urls with the first frame", () => {
    const split = splitReferences(resolveFalModel("kling-o3-v2v-ref"), [face, face, face, motion]);
    expect(split.images).toHaveLength(3);
    expect(split.videos).toEqual([motion]);
  });

  it("rejects an audio ref before any fetch", async () => {
    const voice = temp.file("voice.mp3", new Uint8Array([3]), "audio/mpeg", "3".repeat(64));
    const { message, fetchMock } = await rejected({
      model: "kling-o3-v2v-ref",
      prompt: "p",
      image,
      refs: [voice, motion]
    });
    expect(message).toBe(
      `[ai] fal model "kling-o3-v2v-ref" takes no reference audio, got 1.${SECOND_LINE}`
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is priced at 0.168 USD per generated second", () => {
    expect(bundledPrices["kling-o3-v2v-ref"]).toBe(0.168);
    const request = { model: "kling-o3-v2v-ref", prompt: "p", seconds: 10 };
    expect(videoCostUsd(createTestCtx(), request)).toBe(1.68);
  });
});
