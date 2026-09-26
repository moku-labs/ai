import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { VideoFile, VideoRequest } from "../../../video/contract";
import { buildFalBody, resolveFalModel } from "../../models";
import { videoCostUsd } from "../../prices";
import type { EstimateInput } from "../../types";
import { createVideoHandler } from "../../video/handler";
import type { TempFiles } from "./fixtures";
import {
  callsOf,
  createTempFiles,
  createTestCtx,
  jsonBodyOf,
  stubFetch,
  submitResponse
} from "./fixtures";

const SECOND_LINE = "\n  Remove refs from input.refs, or use a model that takes more.";

const URLS = { image: "u0", refs: ["u1"], audioRefs: [], videoRefs: [] };

let temp: TempFiles;
let image: VideoFile;
let face: VideoFile;
let voice: VideoFile;
let tail: VideoFile;

beforeAll(() => {
  temp = createTempFiles();
  image = temp.file("key.png", new Uint8Array([1]), "image/png", "1".repeat(64));
  face = temp.file("face.png", new Uint8Array([2]), "image/png", "2".repeat(64));
  voice = temp.file("voice.mp3", new Uint8Array([3]), "audio/mpeg", "3".repeat(64));
  tail = temp.file("tail.mp4", new Uint8Array([4]), "video/mp4", "4".repeat(64));
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

/** The rejection message of submitting `request`, with the fetch mock it ran against. */
async function rejected(
  request: VideoRequest
): Promise<{ message: string; fetchMock: ReturnType<typeof vi.fn> }> {
  const fetchMock = stubFetch();
  const error = await createVideoHandler(createTestCtx())
    .submit(request, {})
    .catch((error_: unknown) => error_);
  return { message: (error as Error).message, fetchMock };
}

/** Cost of a request for `model` with the given first frame and refs. */
function cost(model: string, refs: EstimateInput[], extra: Partial<VideoRequest> = {}): number {
  return videoCostUsd(createTestCtx(), { model, prompt: "p", image, refs, ...extra });
}

describe("minimax-h3-ref body", () => {
  it("sends the H3 Max body shape at 768P", () => {
    const body = buildFalBody(
      resolveFalModel("minimax-h3-ref"),
      { model: "minimax-h3-ref", prompt: "Image 1 walks in" },
      URLS
    );
    expect(body).toEqual({
      prompt: "Image 1 walks in",
      prompt_expansion_mode: "balanced",
      reference_image_urls: ["u0", "u1"],
      duration: 5,
      resolution: "768P",
      aspect_ratio: "9:16"
    });
  });

  it("posts image, audio and video refs to the h3 endpoint", async () => {
    const { url, body } = await submitted({
      model: "minimax-h3-ref",
      prompt: "p",
      image,
      refs: [face, voice, tail]
    });

    expect(url).toBe("https://queue.fal.run/minimax/h3/reference-to-video");
    expect(body.reference_image_urls).toHaveLength(2);
    expect(body.reference_audio_urls).toEqual([expect.stringMatching(/^data:audio\/mpeg;base64,/)]);
    expect(body.reference_video_urls).toEqual([expect.stringMatching(/^data:video\/mp4;base64,/)]);
  });

  it("takes 8 image refs besides the first frame and rejects a 9th", async () => {
    const eight = Array.from({ length: 8 }, () => face);
    const { body } = await submitted({ model: "minimax-h3-ref", prompt: "p", image, refs: eight });
    expect(body.reference_image_urls).toHaveLength(9);

    const { message, fetchMock } = await rejected({
      model: "minimax-h3-ref",
      prompt: "p",
      image,
      refs: [...eight, face]
    });
    expect(message).toBe(
      `[ai] fal model "minimax-h3-ref" takes at most 8 reference images, got 9.${SECOND_LINE}`
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("minimax-h3-ref price", () => {
  it("prices output per resolution", () => {
    expect(cost("minimax-h3-ref", [], { resolution: "480P" })).toBe(0.25);
    expect(cost("minimax-h3-ref", [])).toBe(0.3);
    expect(cost("minimax-h3-ref", [], { resolution: "2K" })).toBe(0.65);
    expect(cost("minimax-h3-ref", [], { resolution: "4K" })).toBe(0.8);
  });

  it("keeps the first 5 reference images free and bills $0.08 for each extra", () => {
    expect(cost("minimax-h3-ref", [face, face, face, face])).toBe(0.3);
    expect(cost("minimax-h3-ref", [face, face, face, face, face])).toBe(0.38);
    expect(
      cost(
        "minimax-h3-ref",
        Array.from({ length: 8 }, () => face)
      )
    ).toBe(0.62);
  });

  it("does not count audio or video refs as images", () => {
    expect(cost("minimax-h3-ref", [face, face, face, face, voice, tail])).toBe(0.3);
  });

  it("counts an unresolved ref as an image", () => {
    const unresolved: EstimateInput = { $ref: "face" };
    expect(cost("minimax-h3-ref", [face, face, face, face, unresolved])).toBe(0.38);
  });
});

describe("gemini-omni-1.1-flash body", () => {
  it("sends image_url, integer duration, 720p and aspect_ratio; no audio flag", async () => {
    const { url, body } = await submitted({
      model: "gemini-omni-1.1-flash",
      prompt: "p",
      image,
      seconds: 8
    });

    expect(url).toBe("https://queue.fal.run/google/gemini-omni-flash/v1.1/image-to-video");
    expect(body).toEqual({
      prompt: "p",
      image_url: expect.stringMatching(/^data:image\/png;base64,/),
      duration: 8,
      resolution: "720p",
      aspect_ratio: "9:16"
    });
  });

  it("takes end_image_url through params", () => {
    const body = buildFalBody(
      resolveFalModel("gemini-omni-1.1-flash"),
      { model: "gemini-omni-1.1-flash", prompt: "p", params: { end_image_url: "u9" } },
      URLS
    );
    expect(body.end_image_url).toBe("u9");
  });

  it("rejects refs", async () => {
    const { message } = await rejected({
      model: "gemini-omni-1.1-flash",
      prompt: "p",
      image,
      refs: [face]
    });
    expect(message).toBe(
      `[ai] fal model "gemini-omni-1.1-flash" takes no reference images, got 1.${SECOND_LINE}`
    );
  });
});

describe("gemini-omni-1.1-flash-ref body", () => {
  it("leads image_urls with the first frame and sends reference_video_urls", async () => {
    const { url, body } = await submitted({
      model: "gemini-omni-1.1-flash-ref",
      prompt: "<IMAGE_REF_0> turns",
      image,
      refs: [face, tail],
      aspect: "16:9",
      resolution: "1080p"
    });

    expect(url).toBe("https://queue.fal.run/google/gemini-omni-flash/v1.1/reference-to-video");
    expect(body).toEqual({
      prompt: "<IMAGE_REF_0> turns",
      image_urls: [
        expect.stringMatching(/^data:image\/png;base64,/),
        expect.stringMatching(/^data:image\/png;base64,/)
      ],
      reference_video_urls: [expect.stringMatching(/^data:video\/mp4;base64,/)],
      duration: 5,
      resolution: "1080p",
      aspect_ratio: "16:9"
    });
  });

  it("omits reference_video_urls without video refs", () => {
    const body = buildFalBody(
      resolveFalModel("gemini-omni-1.1-flash-ref"),
      { model: "gemini-omni-1.1-flash-ref", prompt: "p" },
      URLS
    );
    expect(body).toEqual({
      prompt: "p",
      image_urls: ["u0", "u1"],
      duration: 5,
      resolution: "720p",
      aspect_ratio: "9:16"
    });
  });

  it("takes 9 image refs besides the first frame and rejects a 10th", async () => {
    const nine = Array.from({ length: 9 }, () => face);
    const { body } = await submitted({
      model: "gemini-omni-1.1-flash-ref",
      prompt: "p",
      image,
      refs: nine
    });
    expect(body.image_urls).toHaveLength(10);

    const { message, fetchMock } = await rejected({
      model: "gemini-omni-1.1-flash-ref",
      prompt: "p",
      image,
      refs: [...nine, face]
    });
    expect(message).toBe(
      `[ai] fal model "gemini-omni-1.1-flash-ref" takes at most 9 reference images, got 10.${SECOND_LINE}`
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects audio refs and a 4th video ref", async () => {
    const audio = await rejected({
      model: "gemini-omni-1.1-flash-ref",
      prompt: "p",
      image,
      refs: [voice]
    });
    expect(audio.message).toBe(
      `[ai] fal model "gemini-omni-1.1-flash-ref" takes no reference audio, got 1.${SECOND_LINE}`
    );

    const videos = await rejected({
      model: "gemini-omni-1.1-flash-ref",
      prompt: "p",
      image,
      refs: [tail, tail, tail, tail]
    });
    expect(videos.message).toBe(
      `[ai] fal model "gemini-omni-1.1-flash-ref" takes at most 3 video references, got 4.${SECOND_LINE}`
    );
  });
});

describe("gemini-omni-1.1-flash prices", () => {
  it.each([
    "gemini-omni-1.1-flash",
    "gemini-omni-1.1-flash-ref"
  ])("%s: $0.03 / $0.10 / $0.15 / $0.30 per second at 360p / 720p / 1080p / 4k", alias => {
    expect(cost(alias, [], { resolution: "360p" })).toBe(0.15);
    expect(cost(alias, [])).toBe(0.5);
    expect(cost(alias, [], { resolution: "1080p" })).toBe(0.75);
    expect(cost(alias, [], { resolution: "4k", seconds: 10 })).toBe(3);
  });
});
